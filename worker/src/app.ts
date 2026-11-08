// Mini-app Telegram : le programme en plein écran, dans Telegram.
//
//   GET  /app              la page (app.html)
//   POST /app/api/state    { initData }                 -> programme + mes sorties + réglages
//   POST /app/api/act      { initData, op, id, arg? }   -> ⭐ 🎟 ✅ ★ 🔕 (mêmes effets que les boutons)
//
// Qui parle ? Telegram passe à la page `initData`, signé avec le token du bot :
// on le vérifie (HMAC), on n'a donc ni login ni mot de passe.
// Les actions passent par le même code que les boutons du chat (handleUpdate) :
// annonces au groupe, fiches mises à jour, tout reste cohérent.
import { handleUpdate } from "./bot";
import { Env, Item, itemText } from "./lib";
import { asLang } from "./i18n";
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
const OPS = new Set(["i", "ui", "v", "r", "x", "u", "bd", "bx"]);

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

  if (url.pathname === "/app/api/state") return Response.json(await state(env, me.chat_id, asLang(me.lang)));
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
    return Response.json(await state(env, me.chat_id, asLang(me.lang)));
  }
  return new Response("not found", { status: 404 });
}

/** Tout ce qu'affiche la page, en une fois (quelques centaines de lignes au plus). */
async function state(env: Env, chat: number, lang: "fr" | "en") {
  const since = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'current_since'").first<{ value: string }>())?.value ?? "";
  // À l'affiche dans mes lieux + tout ce sur quoi j'ai réagi (⭐ 🎟 ✅, même passé).
  const { results: items } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE (i.venue_id IN (SELECT venue_id FROM subscriptions WHERE chat_id = ?1)
            AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                      ELSE i.last_seen >= ?2 END)
            AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= date('now')))
        OR i.id IN (SELECT item_id FROM reactions WHERE chat_id = ?1 AND (interested = 1 OR status = 'seen'))
     LIMIT 600`,
  ).bind(chat, since).all<Item & { venue: string }>();
  const ids = JSON.stringify(items.map((i) => i.id));
  const { results: reacts } = await env.DB.prepare(
    `SELECT r.chat_id, r.item_id, r.interested, r.status, r.rating, r.comment, r.booked_at, r.updated_at, u.first_name
     FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     WHERE r.item_id IN (SELECT value FROM json_each(?)) AND (r.chat_id = ? OR r.interested = 1 OR r.status = 'seen')`,
  ).bind(ids, chat).all<any>();
  const mine = new Map<string, any>(), friends = new Map<string, any[]>();
  for (const r of reacts) {
    if (r.chat_id === chat) mine.set(r.item_id, r);
    else (friends.get(r.item_id) ?? friends.set(r.item_id, []).get(r.item_id)!)
      .push({ name: r.first_name, star: r.interested && r.status !== "seen" ? 1 : 0, booked: r.booked_at, seen: r.status === "seen" ? 1 : 0, rating: r.rating });
  }
  const { results: venues } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind, EXISTS (SELECT 1 FROM subscriptions s WHERE s.chat_id = ? AND s.venue_id = v.id) AS followed
     FROM venues v WHERE v.active = 1 ORDER BY CASE v.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position`,
  ).bind(chat).all<any>();
  return {
    lang,
    venues,
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
