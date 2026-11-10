// Cercles d'amis : qui voit les ⭐ 🎟 ✅ de qui.
//
// - S'inscrire avec le lien PERSONNEL de quelqu'un = être connecté à cette personne.
//   (L'ancien lien commun du bot reste valable : il connecte à la propriétaire.)
// - « Mes amis » (mini-app) suggère les amis de mes amis ; « Ajouter » envoie une
//   demande en privé (✓ Accepter / ✖ Ignorer). Rien n'est visible avant le oui.
// - Retirer quelqu'un : la personne n'est pas prévenue.
import { Env, esc, send, tg } from "./lib";
import { Lang, asLang } from "./i18n";

const pair = (x: number, y: number) => (x < y ? [x, y] : [y, x]);

const M = {
  fr: {
    request: (who: string) => `👋 <b>${who}</b> veut se connecter avec toi sur Berlin Encore! : vous verrez vos envies, réservations et critiques.`,
    accept: "✓ Accepter", ignore: "✖ Ignorer",
    accepted: (who: string) => `🤝 Toi et <b>${who}</b> êtes connectés.`,
    acceptedThem: (who: string) => `🤝 <b>${who}</b> a accepté : vous êtes connectés.`,
    ignored: "👌 Demande ignorée.",
    gone: "Cette demande n'existe plus.",
    viaLink: (who: string) => `🤝 Connecté·e à <b>${who}</b> (lien d'invitation).`,
    invite: (link: string) => `🔗 Ton lien d'invitation personnel : qui s'inscrit avec est connecté·e à toi.\n${link}`,
  },
  en: {
    request: (who: string) => `👋 <b>${who}</b> wants to connect with you on Berlin Encore!: you'll see each other's picks, bookings and reviews.`,
    accept: "✓ Accept", ignore: "✖ Ignore",
    accepted: (who: string) => `🤝 You and <b>${who}</b> are now connected.`,
    acceptedThem: (who: string) => `🤝 <b>${who}</b> accepted: you're connected.`,
    ignored: "👌 Request ignored.",
    gone: "This request no longer exists.",
    viaLink: (who: string) => `🤝 Connected with <b>${who}</b> (invite link).`,
    invite: (link: string) => `🔗 Your personal invite link: whoever joins with it is connected to you.\n${link}`,
  },
};
const t = (lang: string | null | undefined) => M[asLang(lang) as Lang];

type U = { chat_id: number; first_name: string; lang: string | null };
const user = (env: Env, id: number) =>
  env.DB.prepare("SELECT chat_id, first_name, lang FROM users WHERE chat_id = ? AND active = 1").bind(id).first<U>();

/** Code du lien personnel (créé au premier besoin). */
export async function personalCode(env: Env, chat: number): Promise<string> {
  const row = await env.DB.prepare("SELECT invite_code FROM users WHERE chat_id = ?").bind(chat).first<{ invite_code: string | null }>();
  if (row?.invite_code) return row.invite_code;
  const code = "p" + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
  await env.DB.prepare("UPDATE users SET invite_code = ? WHERE chat_id = ?").bind(code, chat).run();
  return code;
}
/** /nouveaulien : l'ancien lien personnel ne marche plus. */
export async function resetCode(env: Env, chat: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET invite_code = NULL WHERE chat_id = ?").bind(chat).run();
}
export async function inviteMessage(env: Env, chat: number, lang: string | null): Promise<string> {
  return t(lang).invite(`https://t.me/${env.BOT_USERNAME}?start=${await personalCode(env, chat)}`);
}
/** À qui appartient ce code personnel (personne active), sinon null. */
export async function codeOwner(env: Env, code: string | undefined): Promise<number | null> {
  if (!code || !/^p[0-9a-z]{4,20}$/.test(code)) return null;
  const r = await env.DB.prepare("SELECT chat_id FROM users WHERE invite_code = ? AND active = 1").bind(code).first<{ chat_id: number }>();
  return r?.chat_id ?? null;
}

export async function connect(env: Env, x: number, y: number): Promise<void> {
  if (x === y) return;
  const [a, b] = pair(x, y);
  await env.DB.prepare(
    `INSERT INTO connections (a, b, status) VALUES (?, ?, 'ok')
     ON CONFLICT(a, b) DO UPDATE SET status = 'ok'`).bind(a, b).run();
}

/** Lien personnel ouvert par quelqu'un de déjà inscrit : connectés tout de suite (le lien vaut accord). */
export async function connectViaLink(env: Env, me: number, owner: number): Promise<void> {
  if (me === owner) return;
  await connect(env, me, owner);
  const [u1, u2] = [await user(env, me), await user(env, owner)];
  if (u1 && u2) {
    await send(env, me, t(u1.lang).viaLink(esc(u2.first_name)));
    await send(env, owner, t(u2.lang).viaLink(esc(u1.first_name)));
  }
}

/** Amis, demandes reçues / envoyées, suggestions (amis de mes amis), pour la mini-app. */
export async function circleState(env: Env, me: number) {
  const { results: rows } = await env.DB.prepare(
    `SELECT c.a, c.b, c.status, c.requested_by, u.chat_id AS id, u.first_name AS name FROM connections c
     JOIN users u ON u.chat_id = CASE WHEN c.a = ?1 THEN c.b ELSE c.a END AND u.active = 1
     WHERE c.a = ?1 OR c.b = ?1 ORDER BY u.first_name`).bind(me).all<any>();
  const friends = rows.filter((r) => r.status === "ok").map((r) => ({ id: r.id, name: r.name }));
  const incoming = rows.filter((r) => r.status === "pending" && r.requested_by !== me).map((r) => ({ id: r.id, name: r.name }));
  const outgoing = rows.filter((r) => r.status === "pending" && r.requested_by === me).map((r) => ({ id: r.id, name: r.name }));
  const { results: sugg } = await env.DB.prepare(
    `WITH mine AS (SELECT CASE WHEN a = ?1 THEN b ELSE a END AS f FROM connections WHERE (a = ?1 OR b = ?1) AND status = 'ok'),
          fof AS (SELECT CASE WHEN c.a = m.f THEN c.b ELSE c.a END AS s, m.f AS via FROM connections c JOIN mine m
                    ON (c.a = m.f OR c.b = m.f) AND c.status = 'ok')
     SELECT u.chat_id AS id, u.first_name AS name, group_concat(DISTINCT v.first_name) AS via
     FROM fof JOIN users u ON u.chat_id = fof.s AND u.active = 1 JOIN users v ON v.chat_id = fof.via
     WHERE fof.s != ?1 AND NOT EXISTS (SELECT 1 FROM connections x WHERE (x.a = ?1 AND x.b = fof.s) OR (x.b = ?1 AND x.a = fof.s))
     GROUP BY u.chat_id ORDER BY u.first_name LIMIT 30`).bind(me).all<any>();
  return { friends, incoming, outgoing, suggestions: sugg.map((s) => ({ id: s.id, name: s.name, via: String(s.via ?? "").split(",") })) };
}

/** « Ajouter » : seulement un ami d'ami ; si l'autre m'avait déjà demandé, c'est accepté. */
/** Demande d'ami. `byHandle` : par pseudo (n'importe qui du bot, qui devra accepter) ;
 *  sinon seulement un ami d'ami (suggestions). */
export async function requestFriend(env: Env, me: number, other: number, byHandle = false): Promise<"sent" | "connected" | "already" | "not_allowed"> {
  if (other === me) return "not_allowed";
  const st = await circleState(env, me);
  if (st.friends.some((x) => x.id === other)) return "already";
  if (st.outgoing.some((x) => x.id === other)) return "sent";
  if (st.incoming.some((x) => x.id === other)) { await acceptFriend(env, me, other); return "connected"; }
  if (!byHandle && !st.suggestions.some((x) => x.id === other)) return "not_allowed";
  const [a, b] = pair(me, other);
  await env.DB.prepare("INSERT OR IGNORE INTO connections (a, b, status, requested_by) VALUES (?, ?, 'pending', ?)").bind(a, b, me).run();
  const [u1, u2] = [await user(env, me), await user(env, other)];
  if (u1 && u2) {
    const T = t(u2.lang);
    await send(env, other, T.request(esc(u1.first_name)), {
      inline_keyboard: [[{ text: T.accept, callback_data: `fa:${me}` }, { text: T.ignore, callback_data: `fx:${me}` }]],
    });
  }
  return "sent";
}

export async function acceptFriend(env: Env, me: number, from: number): Promise<boolean> {
  const [a, b] = pair(me, from);
  const res = await env.DB.prepare(
    "UPDATE connections SET status = 'ok' WHERE a = ? AND b = ? AND status = 'pending' AND requested_by = ?").bind(a, b, from).run();
  if (!res.meta.changes) return false;
  const [u1, u2] = [await user(env, me), await user(env, from)];
  if (u1 && u2) await send(env, from, t(u2.lang).acceptedThem(esc(u1.first_name)));
  return true;
}

export async function ignoreFriend(env: Env, me: number, from: number): Promise<boolean> {
  const [a, b] = pair(me, from);
  const res = await env.DB.prepare(
    "DELETE FROM connections WHERE a = ? AND b = ? AND status = 'pending' AND requested_by = ?").bind(a, b, from).run();
  return !!res.meta.changes;
}

/** Retirer (ou annuler ma demande) : sans prévenir l'autre. */
export async function removeFriend(env: Env, me: number, other: number): Promise<void> {
  const [a, b] = pair(me, other);
  await env.DB.prepare("DELETE FROM connections WHERE a = ? AND b = ?").bind(a, b).run();
}

/** Boutons ✓ / ✖ d'une demande reçue en privé. Renvoie true si `data` était pour nous. */
export async function friendCallback(env: Env, cq: any, me: number, lang: string | null): Promise<boolean> {
  const m = /^f([ax]):(\d+)$/.exec(String(cq.data ?? ""));
  if (!m) return false;
  const from = Number(m[2]);
  const T = t(lang);
  const other = await user(env, from);
  const ok = m[1] === "a" ? await acceptFriend(env, me, from) : await ignoreFriend(env, me, from);
  const text = !ok ? T.gone : m[1] === "a" ? T.accepted(esc(other?.first_name ?? "?")) : T.ignored;
  if (cq.message?.message_id) {
    await tg(env, "editMessageText", { chat_id: me, message_id: cq.message.message_id, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  return true;
}
