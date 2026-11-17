// 🗳 « Proposer une sortie » : une fiche, des amis, 1 à 3 créneaux.
// Chaque invité répond par créneau (oui / non) ; tous les participants voient toutes les réponses.
// « C'est calé » (la personne qui propose) → 🎟 réservé pour tous ceux qui ont dit oui à ce créneau.
// Lien public /app?p=<id> : on peut répondre sans compte (prénom + clé gardée sur l'appareil).
// Groupes d'amis : raccourcis privés de la personne qui propose, jamais montrés aux invités.
import { Env, appLink, esc, inbox, inCircle, send } from "./lib";
import { Lang, asLang } from "./i18n";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer as ArrayBuffer);
/** Aujourd'hui à Berlin (à une heure près, suffisant pour des dates). */
const today = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const SLOT_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
export const PROP_RE = /^[a-f0-9]{24}$/;
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

type Me = { chat_id: number; first_name: string };
type Row = { proposal_id: string; pid: string; chat_id: number | null; name: string; answers: string | null; note: string | null; answered_at: string | null };

const T = {
  fr: {
    invite: (who: string, title: string, others: string, slots: string) => `💌 <b>${who}</b> te propose <b>${title}</b>${others ? `, avec ${others}` : ""} : ${slots} ?`,
    set: (title: string, when: string, who: string) => `✓ C'est calé : <b>${title}</b>, ${when}, avec ${who}. C'est dans Mes sorties.`,
    answer: "Répondre", or: " ou ", and: " et ",
    cancel: (who: string, title: string) => `✕ <b>${who}</b> a annulé la proposition : <b>${title}</b>.`,
  },
  en: {
    invite: (who: string, title: string, others: string, slots: string) => `💌 <b>${who}</b> suggests <b>${title}</b>${others ? `, with ${others}` : ""}: ${slots}?`,
    set: (title: string, when: string, who: string) => `✓ It's on: <b>${title}</b>, ${when}, with ${who}. It's in My outings.`,
    answer: "Answer", or: " or ", and: " and ",
    cancel: (who: string, title: string) => `✕ <b>${who}</b> cancelled the suggestion: <b>${title}</b>.`,
  },
};
const DOW = { fr: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const MON = { fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."], en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] };
export function slotLabel(s: string, lang: Lang): string {
  const d = new Date(s.slice(0, 10) + "T12:00:00Z");
  const day = lang === "en" ? `${DOW.en[d.getUTCDay()]} ${d.getUTCDate()} ${MON.en[d.getUTCMonth()]}` : `${DOW.fr[d.getUTCDay()]} ${d.getUTCDate()} ${MON.fr[d.getUTCMonth()]}`;
  return s.length > 10 ? `${day} ${s.slice(11, 16)}` : day;
}
const list = (xs: string[], L: typeof T.fr) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + L.and + xs[xs.length - 1];

async function itemInfo(env: Env, id: string) {
  return env.DB.prepare("SELECT i.id, i.kind, i.title, i.url, i.end_date AS end, i.dates, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id WHERE i.id = ?")
    .bind(id).first<{ id: string; kind: string; title: string; url: string | null; end: string | null; dates: string | null; venue: string }>();
}

/** Nouvelle proposition. to = mes connexions seulement ; slots = 1 à 3 créneaux à venir. */
export async function createProposal(env: Env, me: Me, body: any): Promise<{ id: string } | { error: string }> {
  const itemId = String(body.id ?? "");
  const item = /^[\w-]{1,40}$/.test(itemId) ? await itemInfo(env, itemId) : null;
  if (!item) return { error: "not_found" };
  const slots = [...new Set<string>((Array.isArray(body.slots) ? body.slots : []).map(String))].filter((s) => SLOT_RE.test(s) && s.slice(0, 10) >= today()).sort().slice(0, 3);
  if (!slots.length) return { error: "bad_slots" };
  const ids = (Array.isArray(body.to) ? body.to : []).map(Number).filter((n: number) => Number.isFinite(n) && n !== me.chat_id && inCircle(me.chat_id, n)).slice(0, 12);
  const { results: to } = await env.DB.prepare(
    "SELECT chat_id, first_name, lang FROM users WHERE active = 1 AND chat_id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(ids)).all<{ chat_id: number; first_name: string; lang: string | null }>();
  const note = clean(body.note, 200) || null;
  const id = randomHex(12);
  const yes = JSON.stringify(Object.fromEntries(slots.map((s) => [s, 1])));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO proposals (id, item_id, from_id, note, slots) VALUES (?, ?, ?, ?, ?)").bind(id, item.id, me.chat_id, note, JSON.stringify(slots)),
    // La personne qui propose est partante sur tous ses créneaux (modifiable comme les autres).
    env.DB.prepare("INSERT INTO proposal_people (proposal_id, pid, chat_id, name, answers, answered_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .bind(id, `u${me.chat_id}`, me.chat_id, me.first_name, yes),
    ...to.map((u) => env.DB.prepare("INSERT INTO proposal_people (proposal_id, pid, chat_id, name) VALUES (?, ?, ?, ?)").bind(id, `u${u.chat_id}`, u.chat_id, u.first_name)),
  ]);
  for (const u of to) {
    const lang = asLang(u.lang), L = T[lang];
    const others = to.filter((o) => o.chat_id !== u.chat_id).map((o) => esc(o.first_name));
    await inbox(env, u.chat_id, "proposal", me.chat_id, item.id, note, null, id);
    await send(env, u.chat_id, L.invite(esc(me.first_name), esc(item.title), list(others, L), slots.map((s: string) => slotLabel(s, lang)).join(L.or))
      + (note ? `\n💬 « ${esc(note)} »` : ""), { inline_keyboard: [[{ text: `💌 ${L.answer}`, url: appLink(env, `p_${id}`) }]] });
  }
  return { id };
}

/** Une proposition telle que la page l'affiche. viewer = pid de la personne qui regarde (ou null). */
async function shape(env: Env, id: string, viewer: string | null, lang: Lang, withIds: boolean) {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!p) return null;
  const item = await itemInfo(env, p.item_id);
  const { results } = await env.DB.prepare("SELECT * FROM proposal_people WHERE proposal_id = ? ORDER BY rowid").bind(id).all<Row>();
  const from = results.find((r) => r.chat_id === p.from_id);
  return {
    id: p.id, item_id: p.item_id, note: p.note, slots: JSON.parse(p.slots), chosen: p.chosen, status: p.status,
    created_at: p.created_at, updated_at: p.updated_at,
    item: item ? { title: item.title, venue: item.venue, kind: item.kind === "film" ? "cinema" : item.kind, end: item.end, url: item.url } : null,
    from: { name: from?.name ?? "?", ...(withIds ? { id: p.from_id } : {}) },
    mine: viewer === `u${p.from_id}`,
    people: results.map((r) => ({
      pid: r.pid === viewer ? r.pid : undefined, me: r.pid === viewer, name: r.name, guest: r.chat_id == null,
      ...(withIds && r.chat_id != null ? { id: r.chat_id } : {}),
      host: r.chat_id === p.from_id, answers: r.answers ? JSON.parse(r.answers) : null, note: r.note,
    })),
    joined: !!viewer && results.some((r) => r.pid === viewer),
    labels: Object.fromEntries((JSON.parse(p.slots) as string[]).map((s) => [s, slotLabel(s, lang)])),
  };
}

/** Mes propositions en cours (ouvertes, ou calées pas encore passées), pour l'état de la page. */
export async function myProposals(env: Env, chat: number, lang: Lang) {
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM proposals p JOIN proposal_people pp ON pp.proposal_id = p.id AND pp.chat_id = ?
     WHERE (p.status = 'open' AND p.created_at > datetime('now', '-60 days'))
        OR (p.status = 'set' AND substr(p.chosen, 1, 10) >= ?)
     ORDER BY p.updated_at DESC LIMIT 20`,
  ).bind(chat, today()).all<{ id: string }>();
  return (await Promise.all(results.map((r) => shape(env, r.id, `u${chat}`, lang, true)))).filter(Boolean);
}

/** Connecté·e : la proposition (même si je n'y suis pas encore : un lien m'a été passé). */
export const getProposal = (env: Env, chat: number, id: string, lang: Lang) => shape(env, id, `u${chat}`, lang, true);

/** Sans compte : vue par le lien ; key = clé de l'appareil (ses propres réponses). Aucun id de compte. */
export async function publicProposal(env: Env, id: string, key: string, lang: Lang) {
  const viewer = /^[a-f0-9]{32}$/.test(key) ? "g" + (await sha("prop:" + key)).slice(0, 24) : null;
  return shape(env, id, viewer, lang, false);
}

function cleanAnswers(raw: any, slots: string[]) {
  const out: Record<string, number> = {};
  for (const s of slots) out[s] = raw && raw[s] ? 1 : 0;
  return JSON.stringify(out);
}

/** Répondre (compte). Pas encore participant (lien reçu) : on rejoint. La personne qui propose est prévenue. */
export async function answerProposal(env: Env, me: Me, id: string, answers: any, note: unknown): Promise<string | null> {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!p || p.status !== "open") return p ? "closed" : "not_found";
  const slots: string[] = JSON.parse(p.slots), a = cleanAnswers(answers, slots), n = clean(note, 200) || null;
  const had = await env.DB.prepare("SELECT answers FROM proposal_people WHERE proposal_id = ? AND pid = ?").bind(id, `u${me.chat_id}`).first<{ answers: string | null }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO proposal_people (proposal_id, pid, chat_id, name, answers, note, answered_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(proposal_id, pid) DO UPDATE SET answers = excluded.answers, note = excluded.note, answered_at = excluded.answered_at`)
      .bind(id, `u${me.chat_id}`, me.chat_id, me.first_name, a, n),
    env.DB.prepare("UPDATE proposals SET updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  if (me.chat_id !== p.from_id && !had?.answers) await inbox(env, p.from_id, "prop_answer", me.chat_id, p.item_id, n, null, id);
  return null;
}

/** Répondre par le lien, sans compte : prénom + clé de l'appareil (pour pouvoir changer d'avis). */
export async function guestAnswer(env: Env, id: string, key: string, name: unknown, answers: any, note: unknown): Promise<string | null> {
  if (!/^[a-f0-9]{32}$/.test(key)) return "bad_request";
  const who = clean(name, 40);
  if (!who) return "bad_name";
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!p || p.status !== "open") return p ? "closed" : "not_found";
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM proposal_people WHERE proposal_id = ?").bind(id).first<{ n: number }>();
  const pid = "g" + (await sha("prop:" + key)).slice(0, 24);
  const had = await env.DB.prepare("SELECT answers FROM proposal_people WHERE proposal_id = ? AND pid = ?").bind(id, pid).first<{ answers: string | null }>();
  if (!had && (count?.n ?? 0) >= 30) return "full";
  const slots: string[] = JSON.parse(p.slots);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO proposal_people (proposal_id, pid, chat_id, name, answers, note, answered_at) VALUES (?, ?, NULL, ?, ?, ?, datetime('now'))
      ON CONFLICT(proposal_id, pid) DO UPDATE SET name = excluded.name, answers = excluded.answers, note = excluded.note, answered_at = excluded.answered_at`)
      .bind(id, pid, who, cleanAnswers(answers, slots), clean(note, 200) || null),
    env.DB.prepare("UPDATE proposals SET updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  if (!had?.answers) await inbox(env, p.from_id, "prop_answer", null, p.item_id, who, null, id);
  return null;
}

/** « C'est calé » (la personne qui propose) : 🎟 pour chaque compte qui a dit oui à ce créneau ; prévenus. */
export async function setProposal(env: Env, me: Me, id: string, slot: string): Promise<string | null> {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!p) return "not_found";
  if (p.from_id !== me.chat_id) return "forbidden";
  const slots: string[] = JSON.parse(p.slots);
  if (!slots.includes(slot) || p.status === "cancelled") return "bad_request";
  const { results } = await env.DB.prepare("SELECT * FROM proposal_people WHERE proposal_id = ?").bind(id).all<Row>();
  const going = results.filter((r) => r.chat_id != null && r.answers && JSON.parse(r.answers)[slot]);
  if (!going.some((r) => r.chat_id === me.chat_id)) going.unshift(results.find((r) => r.chat_id === me.chat_id)!);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = 'set', chosen = ?, updated_at = datetime('now') WHERE id = ?").bind(slot, id),
    ...going.filter(Boolean).map((r) => env.DB.prepare(
      `INSERT INTO reactions (chat_id, item_id, interested, booked_at, booked_on, followup_sent, updated_at)
       VALUES (?, ?, 1, ?, ?, 0, datetime('now'))
       ON CONFLICT(chat_id, item_id) DO UPDATE SET interested = 1, status = NULL, booked_at = excluded.booked_at,
         booked_on = excluded.booked_on, followup_sent = 0, updated_at = excluded.updated_at`,
    ).bind(r.chat_id, p.item_id, slot, now)),
  ]);
  const item = await itemInfo(env, p.item_id);
  const { results: langs } = await env.DB.prepare("SELECT chat_id, lang FROM users WHERE chat_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(going.map((r) => r.chat_id))).all<{ chat_id: number; lang: string | null }>();
  const langOf = new Map(langs.map((u) => [u.chat_id, asLang(u.lang)]));
  for (const r of going) {
    if (!r || r.chat_id === me.chat_id) continue;
    const lang = langOf.get(r.chat_id!) ?? "fr", L = T[lang];
    const others = going.filter((o) => o && o.chat_id !== r.chat_id).map((o) => esc(o.name));
    await inbox(env, r.chat_id!, "prop_set", me.chat_id, p.item_id, null, slot, id);
    await send(env, r.chat_id!, L.set(esc(item?.title ?? "?"), slotLabel(slot, lang), list(others, L)));
  }
  return null;
}

export async function cancelProposal(env: Env, me: Me, id: string): Promise<string | null> {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!p) return "not_found";
  if (p.from_id !== me.chat_id) return "forbidden";
  if (p.status === "cancelled") return null;
  const { results } = await env.DB.prepare("SELECT * FROM proposal_people WHERE proposal_id = ?").bind(id).all<Row>();
  const accounts = results.filter((r) => r.chat_id != null);
  await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(id),
    // Déjà calé : on retire le 🎟 posé par « C'est calé » (seulement s'il est encore sur ce créneau), l'envie reste.
    ...(p.status === "set" && p.chosen ? accounts.map((r) => env.DB.prepare(
      "UPDATE reactions SET booked_at = NULL, booked_on = NULL, updated_at = datetime('now') WHERE chat_id = ? AND item_id = ? AND booked_at = ?",
    ).bind(r.chat_id, p.item_id, p.chosen)) : []),
  ]);
  const item = await itemInfo(env, p.item_id);
  const { results: langs } = await env.DB.prepare("SELECT chat_id, lang FROM users WHERE chat_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(accounts.map((r) => r.chat_id))).all<{ chat_id: number; lang: string | null }>();
  const langOf = new Map(langs.map((u) => [u.chat_id, asLang(u.lang)]));
  for (const r of accounts) {
    if (r.chat_id === me.chat_id) continue;
    const L = T[langOf.get(r.chat_id!) ?? "fr"];
    await inbox(env, r.chat_id!, "prop_cancel", me.chat_id, p.item_id, null, null, id);
    await send(env, r.chat_id!, L.cancel(esc(me.first_name), esc(item?.title ?? "?")));
  }
  return null;
}

// --- Groupes privés -----------------------------------------------------------
export async function myGroups(env: Env, chat: number) {
  const { results } = await env.DB.prepare("SELECT id, name, members FROM friend_groups WHERE owner = ? ORDER BY id").bind(chat).all<any>();
  // Seulement les membres encore connectés ; un groupe vidé disparaît.
  return results.map((g) => ({ id: g.id, name: g.name, members: (JSON.parse(g.members) as number[]).filter((m) => inCircle(chat, m)) }))
    .filter((g) => g.members.length);
}
export async function saveGroup(env: Env, chat: number, name: unknown, members: unknown): Promise<string | null> {
  const n = clean(name, 40);
  const ms = [...new Set((Array.isArray(members) ? members : []).map(Number))].filter((m) => Number.isFinite(m) && m !== chat && inCircle(chat, m)).slice(0, 12);
  if (!n || ms.length < 2) return "bad_request";
  const count = await env.DB.prepare("SELECT COUNT(*) n FROM friend_groups WHERE owner = ?").bind(chat).first<{ n: number }>();
  if ((count?.n ?? 0) >= 30) return "full";
  await env.DB.prepare("INSERT INTO friend_groups (owner, name, members) VALUES (?, ?, ?)").bind(chat, n, JSON.stringify(ms)).run();
  return null;
}
export async function deleteGroup(env: Env, chat: number, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM friend_groups WHERE id = ? AND owner = ?").bind(id, chat).run();
}

/** Rafraîchissement en direct : une empreinte qui change dès que quelque chose me concerne a bougé
 *  (notification reçue, réaction d'un ami ou de moi, proposition où je suis). La page compare et recharge. */
export async function pingStamp(env: Env, chat: number): Promise<string> {
  const r = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(MAX(id), 0) FROM notifications WHERE chat_id = ?1) AS n,
       (SELECT COUNT(*) FROM notifications WHERE chat_id = ?1) AS nc,
       (SELECT COALESCE(MAX(updated_at), '') FROM reactions WHERE chat_id = ?1 OR chat_id IN
          (SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM connections WHERE (a = ?1 OR b = ?1) AND status = 'ok')) AS r,
       (SELECT COALESCE(MAX(p.updated_at), '') FROM proposals p JOIN proposal_people pp ON pp.proposal_id = p.id AND pp.chat_id = ?1) AS p,
       (SELECT COUNT(*) FROM connections WHERE a = ?1 OR b = ?1) AS c,
       (SELECT COALESCE(MAX(last_seen), '') FROM items) AS i`,
  ).bind(chat).first<any>();
  return [r?.n, r?.nc, r?.r, r?.p, r?.c, r?.i].join("|");
}
