// Mini-app Telegram : le programme en plein écran, dans Telegram.
//
//   GET  /app              la page (app.html)
//   POST /app/api/state    { initData }                 -> programme + mes sorties + réglages
//   POST /app/api/act      { initData, op, id, arg?, with? } -> ⭐ 🎟 ✅ ★ 🙅 suivre (mêmes effets que les boutons) ;
//                          with = places 🎟 prises aussi pour ces amis
//   POST /app/api/friend   { initData, op: add|accept|ignore|remove, id } -> 👋 Mes amis
//   POST /app/api/share    { initData, id, to, note? }  -> 💌 « ça te dit ? » (+ un mot) en privé à ces amis
//
// Qui parle ? Telegram passe à la page `initData`, signé avec le token du bot :
// on le vérifie (HMAC), on n'a donc ni login ni mot de passe.
// Les actions passent par le même code que les boutons du chat (handleUpdate) :
// annonces au groupe, fiches mises à jour, tout reste cohérent.
import { handleUpdate, saveReviewFromApp } from "./bot";
import { Env, Item, esc, getItem, getReaction, inCircle, loadCircles, itemText, keyboard, send, whenLabel } from "./lib";
import { acceptFriend, circleState, ignoreFriend, inviteMessage, removeFriend, requestFriend } from "./circles";
import { Lang, asLang } from "./i18n";
import PAGE from "./app.html";

const enc = new TextEncoder();
const hmac = async (key: ArrayBuffer | Uint8Array, msg: string) =>
  crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(msg));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface AppUser { id: number; first_name: string; language_code?: string; username?: string }

/** initData valide (signé par Telegram, < 7 jours) -> l'utilisateur ; sinon null. */
export async function verifyInitData(initData: string, botToken: string, now = Date.now()): Promise<AppUser | null> {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = now / 1000 - Number(p.get("auth_date") || 0);
  if (!(age < 7 * 86400)) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

// Ce que la page a le droit de déclencher (préfixes des boutons du chat).
// « w » (✍️ critique) envoie l'invitation dans le chat : la critique s'écrit en réponse au bot.
// « s » (suivre / ne plus suivre un lieu) : id = le lieu ; « l » (langue) : id = fr | en.
const OPS = new Set(["i", "ui", "v", "r", "w", "x", "u", "bd", "bx", "s", "l"]);

export async function handleApp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  const body: any = await req.json().catch(() => ({}));
  const user = await verifyInitData(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return Response.json({ error: "auth" }, { status: 401 });
  const me = await env.DB.prepare("SELECT chat_id, first_name, lang FROM users WHERE chat_id = ? AND active = 1")
    .bind(user.id).first<{ chat_id: number; first_name: string; lang: string | null }>();
  if (!me) return Response.json({ error: "not_member", bot: env.BOT_USERNAME }, { status: 403 });

  const focus = /^[\w-]{1,40}$/.test(String(body.focus ?? "")) ? String(body.focus) : "";
  if (url.pathname === "/app/api/state") return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  if (url.pathname === "/app/api/act") {
    const op = String(body.op ?? ""), id = String(body.id ?? ""), arg = body.arg == null ? "" : String(body.arg);
    if (!OPS.has(op) || !/^[\w-]{1,40}$/.test(id) || !/^[\w-]{0,20}$/.test(arg)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    // Même chemin qu'un clic dans le chat privé (sans message cliqué : rien à éditer sur place).
    await handleUpdate(env, {
      callback_query: {
        id: "app", from: user, data: arg ? `${op}:${id}:${arg}` : `${op}:${id}`,
        message: { chat: { id: me.chat_id, type: "private" } },
      },
    }, ctx);
    // 🎟 « pour moi + Joss » : les autres places apparaissent réservées chez eux aussi.
    if (op === "bd" && Array.isArray(body.with) && body.with.length) {
      await bookFor(env, me, id, arg, body.with.map(Number).filter(Number.isFinite).slice(0, 8));
    }
    // La langue a pu changer (« l ») : on la relit.
    const lang = op === "l" ? asLang(id) : asLang(me.lang);
    return Response.json(await state(env, me.chat_id, lang, focus));
  }
  if (url.pathname === "/app/api/review") {
    // ✍️ Critique écrite dans l'app : enregistrée, rien n'est envoyé à personne.
    const id = String(body.id ?? "");
    if (!/^[\w-]{1,40}$/.test(id) || typeof body.text !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    if (!(await saveReviewFromApp(env, me.chat_id, id, body.text, ctx))) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/friend") {
    // 👋 Mes amis : add (ami d'ami) | accept | ignore | remove (sans prévenir).
    const op = String(body.op ?? ""), other = Number(body.id);
    if (!Number.isFinite(other) || other === me.chat_id) return Response.json({ error: "bad_request" }, { status: 400 });
    let result: string = "ok";
    if (op === "add") result = await requestFriend(env, me.chat_id, other);
    else if (op === "accept") result = (await acceptFriend(env, me.chat_id, other)) ? "connected" : "gone";
    else if (op === "ignore") await ignoreFriend(env, me.chat_id, other);
    else if (op === "remove") await removeFriend(env, me.chat_id, other);
    else return Response.json({ error: "bad_request" }, { status: 400 });
    await loadCircles(env);
    return Response.json({ result, ...(await state(env, me.chat_id, asLang(me.lang), focus)) });
  }
  if (url.pathname === "/app/api/share") {
    // 💌 « Regarde ça, ça me tente : t'en penses quoi ? », en privé, à une ou plusieurs personnes du bot.
    const id = String(body.id ?? "");
    const to = Array.isArray(body.to) ? body.to.map(Number).filter(Number.isFinite).slice(0, 8) : [];
    if (!/^[\w-]{1,40}$/.test(id) || !to.length) return Response.json({ error: "bad_request" }, { status: 400 });
    const note = String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const sent = await share(env, me, id, to, note);
    return Response.json({ sent, ...(await state(env, me.chat_id, asLang(me.lang), focus)) });
  }
  return new Response("not found", { status: 404 });
}

/** Tout ce qu'affiche la page, en une fois (quelques centaines de lignes au plus). */
async function state(env: Env, chat: number, lang: "fr" | "en", focus = "") {
  const since = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'current_since'").first<{ value: string }>())?.value ?? "";
  // À l'affiche dans mes lieux + tout ce sur quoi j'ai réagi (⭐ 🎟 ✅, même passé).
  const { results: items } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE (i.venue_id IN (SELECT venue_id FROM subscriptions WHERE chat_id = ?1)
            AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                      ELSE i.last_seen >= ?2 END)
            AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= date('now')))
        OR i.id IN (SELECT item_id FROM reactions WHERE chat_id = ?1 AND (interested = 1 OR status = 'seen'))
        OR i.id = ?3   -- fiche ouverte depuis une annonce du groupe (même hors de mes lieux)
     LIMIT 600`,
  ).bind(chat, since, focus).all<Item & { venue: string }>();
  const ids = JSON.stringify(items.map((i) => i.id));
  const { results: reacts } = await env.DB.prepare(
    `SELECT r.chat_id, r.item_id, r.interested, r.status, r.rating, r.comment, r.booked_at, r.updated_at, u.first_name
     FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     WHERE r.item_id IN (SELECT value FROM json_each(?)) AND (r.chat_id = ? OR r.interested = 1 OR r.status = 'seen')`,
  ).bind(ids, chat).all<any>();
  const mine = new Map<string, any>(), friends = new Map<string, any[]>();
  for (const r of reacts) {
    if (r.chat_id === chat) mine.set(r.item_id, r);
    else if (!inCircle(chat, r.chat_id)) continue;   // seulement mes connexions
    else (friends.get(r.item_id) ?? friends.set(r.item_id, []).get(r.item_id)!)
      .push({ id: r.chat_id, name: r.first_name, star: r.interested && r.status !== "seen" ? 1 : 0, booked: r.booked_at, seen: r.status === "seen" ? 1 : 0, rating: r.rating, comment: r.comment });
  }
  const { results: venues } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind, EXISTS (SELECT 1 FROM subscriptions s WHERE s.chat_id = ? AND s.venue_id = v.id) AS followed
     FROM venues v WHERE v.active = 1 ORDER BY CASE v.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position`,
  ).bind(chat).all<any>();
  // « Envoyer à » / « + Joss » : mes connexions seulement.
  const circle = await circleState(env, chat);
  const people = circle.friends;
  const invite = await inviteMessage(env, chat, lang);
  return {
    lang,
    venues,
    people,
    circle,
    invite: invite.split("\n").pop(),
    items: items.map((i) => {
      const r = mine.get(i.id);
      return {
        id: i.id, kind: i.kind, title: i.title, url: i.url, venue: i.venue, venue_id: i.venue_id,
        dates: JSON.parse(i.dates || "[]"), start: i.start_date, end: i.end_date, starred: i.starred,
        text: itemText(i, lang),
        me: r ? { star: r.interested, status: r.status, rating: r.rating, comment: r.comment, booked: r.booked_at, at: r.updated_at } : null,
        friends: friends.get(i.id) ?? [],
      };
    }),
  };
}

type Me = { chat_id: number; first_name: string };
const MSG = {
  fr: {
    share: (who: string) => `💌 <b>${who}</b> a envie d'y aller : ça te dit ?`,
    booked: (who: string, title: string, when: string) => `🎟 <b>${who}</b> a pris une place pour toi : <b>${title}</b>, ${when}.`,
  },
  en: {
    share: (who: string) => `💌 <b>${who}</b> wants to go: are you in?`,
    booked: (who: string, title: string, when: string) => `🎟 <b>${who}</b> got you a ticket: <b>${title}</b>, ${when}.`,
  },
};
/** Personnes actives du bot parmi `ids` (jamais soi-même), avec leur langue. */
async function recipients(env: Env, me: Me, ids: number[]) {
  const { results } = await env.DB.prepare(
    "SELECT chat_id, first_name, lang FROM users WHERE active = 1 AND chat_id != ? AND chat_id IN (SELECT value FROM json_each(?))",
  ).bind(me.chat_id, JSON.stringify(ids)).all<{ chat_id: number; first_name: string; lang: string | null }>();
  return results.filter((u) => inCircle(me.chat_id, u.chat_id));   // 💌 / 🎟 : seulement mes connexions
}

async function share(env: Env, me: Me, id: string, to: number[], note = ""): Promise<string[]> {
  const item = await getItem(env, id);
  if (!item) return [];
  const out: string[] = [];
  for (const u of await recipients(env, me, to)) {
    const lang: Lang = asLang(u.lang);
    const r = await getReaction(env, u.chat_id, id);
    const head = MSG[lang].share(esc(me.first_name)) + (note ? `\n💬 « ${esc(note)} »` : "");
    const res = await send(env, u.chat_id, `${head}\n\n${itemText(item, lang) ?? esc(item.title)}`, keyboard(item, r, lang));
    if (res?.ok) out.push(u.first_name);
  }
  return out;
}

async function bookFor(env: Env, me: Me, id: string, when: string, ids: number[]): Promise<void> {
  const item = await getItem(env, id);
  if (!item || !/^\d{8}(\d{4})?$/.test(when)) return;
  const iso = `${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)}` + (when.length >= 12 ? ` ${when.slice(8, 10)}:${when.slice(10, 12)}` : "");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  for (const u of await recipients(env, me, ids)) {
    await env.DB.prepare(
      `INSERT INTO reactions (chat_id, item_id, interested, booked_at, booked_on, followup_sent, updated_at)
       VALUES (?, ?, 1, ?, ?, 0, datetime('now'))
       ON CONFLICT(chat_id, item_id) DO UPDATE SET interested = 1, status = NULL, booked_at = excluded.booked_at,
         booked_on = excluded.booked_on, followup_sent = 0, updated_at = excluded.updated_at`,
    ).bind(u.chat_id, id, iso, now).run();
    const lang: Lang = asLang(u.lang);
    const r = await getReaction(env, u.chat_id, id);
    await send(env, u.chat_id, MSG[lang].booked(esc(me.first_name), esc(item.title), whenLabel(iso, lang)), keyboard(item, r, lang));
  }
}
