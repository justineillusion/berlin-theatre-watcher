// Mini-app Telegram : le programme en plein écran, dans Telegram.
//
//   GET  /app              la page (app.html)
//   POST /app/api/state    { initData }                 -> programme + mes sorties + réglages
//   POST /app/api/act      { initData, op, id, arg?, with? } -> ⭐ 🎟 ✅ ★ 🙅 suivre (mêmes effets que les boutons) ;
//                          with = places 🎟 prises aussi pour ces amis
//   POST /app/api/friend   { initData, op: add|accept|ignore|remove, id } -> 👋 Mes amis
//   POST /app/api/share    { initData, id, to, note? }  -> 💌 « ça te dit ? » (+ un mot) en privé à ces amis
//
// Même page hors de Telegram (navigateur, écran d'accueil iPhone, plus tard Capacitor) :
//   POST /app/api/login/start            -> { nonce, link }  (lien t.me/<bot>?start=web_<nonce>)
//   POST /app/api/login/poll { nonce }   -> { pending } | { token }  après « ✅ » dans le bot
//   POST /app/api/logout                 (Authorization: Bearer <token>)
//   GET  /app/manifest.webmanifest, /app/sw.js, /app/icon-*.png
//   Partout ailleurs, `Authorization: Bearer <token>` remplace `initData`.
//
// Qui parle ? Telegram passe à la page `initData`, signé avec le token du bot :
// on le vérifie (HMAC), on n'a donc ni login ni mot de passe.
// Les actions passent par le même code que les boutons du chat (handleUpdate) :
// annonces au groupe, fiches mises à jour, tout reste cohérent.
import { handleUpdate, saveReviewFromApp } from "./bot";
import { Env, Item, WEB_ID_BASE, esc, getItem, inbox, setting, getReaction, inCircle, loadCircles, itemText, keyboard, send, whenLabel } from "./lib";
import { acceptFriend, codeOwner, connect, circleState, ignoreFriend, inviteMessage, removeFriend, requestFriend } from "./circles";
import { Lang, asLang, tr } from "./i18n";
import PAGE from "./app.html";
import { webAsset } from "./web/assets";
import { DISTRICT } from "./districts";
import { pushCount, pushTo, subscribe, unsubscribe } from "./push";
import { listPasskeys, loginOptions, loginVerify, registerOptions, registerVerify, removePasskey } from "./passkeys";
import { LOGOS } from "./web/logos";

const enc = new TextEncoder();
// Empreinte de la page (change à chaque déploiement qui la modifie) : la page compare et se recharge.
const BUILD = (() => { let h = 0; for (let i = 0; i < PAGE.length; i++) h = (h * 31 + PAGE.charCodeAt(i)) | 0; return (h >>> 0).toString(36); })();
const PAGE_BUILT = PAGE.replace("__BUILD__", BUILD);
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

// --- App web (hors Telegram) -------------------------------------------------
// Connexion : la page demande un nonce, ouvre t.me/<bot>?start=web_<nonce>, la personne
// confirme dans le bot (bot.ts, « wl: »), la page récupère alors un jeton de session.
// Le jeton (Authorization: Bearer) remplace initData ; on n'en garde que le SHA-256.
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer as ArrayBuffer);
const SESSION_DAYS = 180;

/** Jeton de session valide -> chat_id (et rafraîchit « vu le ») ; sinon null. */
async function sessionUser(env: Env, req: Request, ctx: ExecutionContext): Promise<number | null> {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const h = await sha256(m[1]);
  const row = await env.DB.prepare(`SELECT chat_id FROM web_sessions WHERE token_hash = ? AND seen_at > datetime('now', '-${SESSION_DAYS} days')`)
    .bind(h).first<{ chat_id: number }>();
  if (row) ctx.waitUntil(env.DB.prepare("UPDATE web_sessions SET seen_at = datetime('now') WHERE token_hash = ?").bind(h).run().then(() => {}, () => {}));
  return row?.chat_id ?? null;
}

/** Appli iOS/Android (Capacitor) : la page tourne sur capacitor://localhost et appelle l'API ici. */
const NATIVE_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost", "http://localhost", "https://localhost"]);
function cors(req: Request, res: Response): Response {
  const o = req.headers.get("origin") || "";
  if (!NATIVE_ORIGINS.has(o)) return res;
  const r = new Response(res.body, res);
  r.headers.set("access-control-allow-origin", o);
  r.headers.set("access-control-allow-headers", "content-type, authorization");
  r.headers.set("access-control-allow-methods", "POST, OPTIONS");
  r.headers.set("vary", "origin");
  return r;
}

async function login(env: Env, path: string, body: any): Promise<Response | null> {
  if (path === "/app/api/login/start") {
    const nonce = randomHex(12);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM web_logins WHERE created_at < datetime('now', '-10 minutes')"),
      env.DB.prepare("INSERT INTO web_logins (nonce) VALUES (?)").bind(nonce),
    ]);
    return Response.json({ nonce, link: `https://t.me/${env.BOT_USERNAME}?start=web_${nonce}`, bot: env.BOT_USERNAME });
  }
  if (path === "/app/api/login/poll") {
    const nonce = String(body.nonce ?? "");
    if (!/^[a-f0-9]{24}$/.test(nonce)) return Response.json({ error: "bad_request" }, { status: 400 });
    const row = await env.DB.prepare("SELECT chat_id FROM web_logins WHERE nonce = ? AND created_at > datetime('now', '-10 minutes')")
      .bind(nonce).first<{ chat_id: number | null }>();
    if (!row) return Response.json({ error: "expired" }, { status: 410 });
    if (!row.chat_id) return Response.json({ pending: true });
    const token = randomHex(32);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM web_logins WHERE nonce = ?").bind(nonce),
      env.DB.prepare("INSERT INTO web_sessions (token_hash, chat_id) VALUES (?, ?)").bind(await sha256(token), row.chat_id),
    ]);
    return Response.json({ token });
  }
  return null;
}

/** Bot (/start web_<nonce> puis « ✅ Oui ») : la demande de connexion est rattachée à cette personne. */
export async function confirmWebLogin(env: Env, nonce: string, chat: number): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE web_logins SET chat_id = ? WHERE nonce = ? AND chat_id IS NULL AND created_at > datetime('now', '-10 minutes')",
  ).bind(chat, nonce).run();
  return !!r.meta.changes;
}

// --- Connexion par email ----------------------------------------------------
//   POST /app/api/login/config            -> { email: bool }  (email activé = RESEND_API_KEY posé)
//   POST /app/api/login/email { email }   -> { id } ; envoie un code à 6 chiffres + un lien
//   POST /app/api/login/code  { id, code }-> { token }   (5 essais, 15 min)
//   POST /app/api/login/link  { link }    -> { token }   (lien /app?login=<link> de l'email)
//   POST /app/api/email       { email }   (connecté·e) lie / change / retire (« ») mon adresse
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const APP_URL = (env: Env) => (env.APP_URL || "https://berlin-encore.pages.dev").replace(/\/$/, "");

const MAIL = {
  fr: { subject: "Ta connexion à Berlin Encore!", hi: (n: string) => `Bonjour ${n},`, p: "Touche ce bouton pour te connecter :", code: "Le lien s'ouvre dans le mauvais navigateur ? Tape ce code dans l'app :", btn: "Ouvrir Berlin Encore!", note: "Valable 15 minutes. Si tu n'as rien demandé, ignore cet email." },
  en: { subject: "Your Berlin Encore! sign-in", hi: (n: string) => `Hi ${n},`, p: "Tap this button to sign in:", code: "Link opens in the wrong browser? Type this code in the app:", btn: "Open Berlin Encore!", note: "Valid for 15 minutes. If you didn't ask for this, ignore this email." },
};
// Inscription : même email, bouton de confirmation (le code reste en secours).
const JOIN_MAIL = {
  fr: { subject: "Confirme ton inscription à Berlin Encore!", p: "Touche ce bouton pour confirmer ton inscription :", btn: "Confirmer mon inscription", note: "Valable 15 minutes. Si tu n'as rien demandé, ignore cet email." },
  en: { subject: "Confirm your Berlin Encore! sign-up", p: "Tap this button to confirm your sign-up:", btn: "Confirm my sign-up", note: "Valid for 15 minutes. If you didn't ask for this, ignore this email." },
};

/** Bouton d'abord ; le code en secours (le lien peut s'ouvrir dans Safari au lieu de l'app d'écran d'accueil). join = inscription. */
async function sendLoginMail(env: Env, to: string, name: string, lang: Lang, code: string, link: string, join = false): Promise<boolean> {
  const M = MAIL[lang], J = JOIN_MAIL[lang];
  const url = `${APP_URL(env)}/app?login=${link}`;
  const button = (label: string) => `<p><a href="${url}" style="display:inline-block;background:#d7263d;color:#fff;padding:12px 18px;text-decoration:none;font-weight:700">${label}</a></p>`;
  const body = `<p>${join ? J.p : M.p}</p>${button(join ? J.btn : M.btn)}
<p style="color:#686e75;font-size:14px;margin-top:22px">${M.code}</p>
<p style="font-size:26px;font-weight:800;letter-spacing:.15em;margin:4px 0 18px">${code}</p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;color:#111214;max-width:440px">
<p style="font-size:22px;font-weight:800;margin:0 0 16px">Berlin Encore<span style="color:#d7263d">!</span></p>
<p>${esc(M.hi(name))}</p>${body}
<p style="color:#686e75;font-size:13px">${M.note}</p></div>`;
  const text = `${M.hi(name)}\n\n${join ? J.p : M.p} ${url}\n\n${M.code} ${code}\n\n${M.note}`;
  const subject = join ? J.subject : M.subject;
  const r = await fetch(`${env.RESEND_API || "https://api.resend.com"}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "Berlin Encore! <onboarding@resend.dev>", to: [to], subject, html, text }),
  }).catch(() => null);
  if (!r?.ok) console.log("mail failed", r?.status, await r?.text().catch(() => ""));
  return !!r?.ok;
}

async function newSession(env: Env, chat: number): Promise<string> {
  const token = randomHex(32);
  await track(env, null, chat, "login");
  await env.DB.prepare("INSERT INTO web_sessions (token_hash, chat_id) VALUES (?, ?)").bind(await sha256(token), chat).run();
  return token;
}

/** Code à 6 chiffres + lien, envoyés par email (3 demandes / 15 min). Renvoie l'id de la demande.
 *  withCode = false (inscription) : lien seul ; le code tiré au sort n'est envoyé nulle part, donc inutilisable. */
async function mailCode(env: Env, chat: number, email: string, name: string, lang: Lang, join = false): Promise<string | Response> {
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM email_logins WHERE chat_id = ? AND created_at > datetime('now', '-15 minutes')")
    .bind(chat).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 3) return Response.json({ error: "too_many" }, { status: 429 });
  if (await tooMany(env, "mail:", 90, 1440)) return slowDown();   // plafond du jour (Resend gratuit : 100 / jour)
  const id = randomHex(12), link = randomHex(24);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_logins WHERE created_at < datetime('now', '-15 minutes')"),
    env.DB.prepare("INSERT INTO email_logins (id, chat_id, code_hash, link_hash) VALUES (?, ?, ?, ?)")
      .bind(id, chat, await sha256(id + code), await sha256(link)),
  ]);
  if (!(await sendLoginMail(env, email, name, lang, code, link, join))) return Response.json({ error: "mail_failed" }, { status: 502 });
  return id;
}

/** Lien d'invitation : code personnel d'une personne active, ou l'ancien lien commun (→ la propriétaire). */
async function inviterOf(env: Env, invite: unknown): Promise<{ chat_id: number; first_name: string; photo: string | null } | null> {
  const code = String(invite ?? "");
  let chat = await codeOwner(env, code);
  if (!chat && code && code === await setting(env, "invite_code") && env.OWNER_CHAT_ID) chat = Number(env.OWNER_CHAT_ID);
  if (!chat) return null;
  return env.DB.prepare("SELECT chat_id, first_name, photo FROM users WHERE chat_id = ? AND active = 1").bind(chat)
    .first<{ chat_id: number; first_name: string; photo: string | null }>();
}

/** Après le premier code valide : le compte devient actif, suit tous les lieux, est connecté à qui l'a invité·e. */
async function finishSignup(env: Env, chat: number): Promise<void> {
  const u = await env.DB.prepare("SELECT pending, invited_by, first_name FROM users WHERE chat_id = ?").bind(chat)
    .first<{ pending: number; invited_by: number | null; first_name: string }>();
  if (!u) return;
  if (u.invited_by && u.invited_by !== chat) {   // une fois : retirer l'ami plus tard reste possible
    await connect(env, chat, u.invited_by);
    await env.DB.prepare("UPDATE users SET invited_by = NULL WHERE chat_id = ?").bind(chat).run();
    await loadCircles(env);
  }
  if (!u.pending) return;
  await track(env, null, chat, "signup");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET active = 1, pending = 0 WHERE chat_id = ?").bind(chat),
    env.DB.prepare("INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed) SELECT ?, id, 1 FROM venues WHERE active = 1 AND optional = 0").bind(chat),
  ]);
  if (env.OWNER_CHAT_ID) {
    const owner = await env.DB.prepare("SELECT lang FROM users WHERE chat_id = ?").bind(Number(env.OWNER_CHAT_ID)).first<{ lang: string | null }>();
    await send(env, env.OWNER_CHAT_ID, tr(owner?.lang).joined(`${esc(u.first_name)} (web)`));
  }
}

/** Tracking (docs/tracking.md) : un événement = qui, quoi, sur quel item, vers quoi. Jamais bloquant. */
const OP_EVENT: Record<string, string> = { i: "want", ui: "unwant", v: "seen", r: "rate", w: "review_open", x: "not_for_me", u: "undo", bd: "book", bx: "book_cancel", s: "venue_toggle", l: "lang" };
const TRACKABLE = new Set(["link_out", "calendar_add", "invite_share", "invite_copy", "filter"]);
function track(env: Env, ctx: ExecutionContext | null, chat: number | null, name: string, item: string | null = null, target: string | null = null) {
  const p = env.DB.prepare("INSERT INTO events (chat_id, name, item_id, target) VALUES (?, ?, ?, ?)")
    .bind(chat, name, item, target ? target.slice(0, 120) : null).run().then(() => {}, () => {});
  if (ctx) ctx.waitUntil(p); return p;
}

/** Anti-robots : compte les coups par clé (IP, global) sur une fenêtre glissante ; au-delà de max → bloqué (et noté pour l'admin). */
async function tooMany(env: Env, key: string, max: number, minutes: number): Promise<boolean> {
  if (/:(127\.0\.0\.1|::1)?$/.test(key) && !key.endsWith("all:") && key !== "mail:") return false;   // tests locaux (en prod l'IP est toujours là)
  const r = await env.DB.prepare(`SELECT COUNT(*) n FROM rate_hits WHERE key = ? AND at > datetime('now', '-${minutes} minutes')`).bind(key).first<{ n: number }>();
  if ((r?.n ?? 0) >= max) {
    await env.DB.prepare("INSERT INTO rate_hits (key) VALUES (?)").bind("blocked:" + key.split(":")[0]).run();
    return true;
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO rate_hits (key) VALUES (?)").bind(key),
    env.DB.prepare("DELETE FROM rate_hits WHERE at < datetime('now', '-2 days')"),
  ]);
  return false;
}
const slowDown = () => Response.json({ error: "too_many" }, { status: 429 });
/** Formulaire rempli par un robot : champ piège rempli, ou envoyé moins d'une seconde après l'affichage. On fait semblant. */
const looksBot = (body: any) => !!String(body.website ?? "").trim() || (typeof body.t === "number" && body.t < 900);
const fakeSent = () => Response.json({ id: randomHex(12) });

async function emailLogin(env: Env, path: string, body: any, ip = ""): Promise<Response | null> {
  if (path === "/app/api/login/config") return Response.json({ email: !!env.RESEND_API_KEY, bot: env.BOT_USERNAME, v: BUILD });
  if (path === "/app/api/login/email") {
    if (!env.RESEND_API_KEY) return Response.json({ error: "mail_off" }, { status: 503 });
    if (looksBot(body)) return fakeSent();
    if (await tooMany(env, "login:" + ip, 10, 60)) return slowDown();
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) return Response.json({ error: "bad_email" }, { status: 400 });
    const u = await env.DB.prepare("SELECT chat_id, first_name, lang FROM users WHERE email = ? AND active = 1")
      .bind(email).first<{ chat_id: number; first_name: string; lang: string | null }>();
    // Bande d'amis : on dit franchement quand l'adresse n'est liée à aucun compte.
    if (!u) return Response.json({ error: "unknown_email" }, { status: 404 });
    const sent = await mailCode(env, u.chat_id, email, u.first_name, asLang(u.lang));
    return sent instanceof Response ? sent : Response.json({ id: sent });
  }
  if (path === "/app/api/teaser") return Response.json(await teaser(env));
  if (path === "/app/api/invite/info") {
    // Page d'accueil d'un lien d'invitation : qui invite (prénom, photo), sans rien révéler d'autre.
    const inviter = await inviterOf(env, body.invite);
    if (!inviter) return Response.json({ error: "bad_invite" }, { status: 404 });
    return Response.json({ name: inviter.first_name, photo: inviter.photo ?? null });
  }
  if (path === "/app/api/signup") {
    // Inscription web : prénom + email ; le compte n'existe vraiment qu'après le clic sur le lien de l'email.
    if (!env.RESEND_API_KEY) return Response.json({ error: "mail_off" }, { status: 503 });
    if (looksBot(body)) return Response.json({ id: randomHex(12), link: true });
    // 4 inscriptions / h par IP, 25 / h en tout ; les comptes jamais confirmés disparaissent après 2 jours.
    if (await tooMany(env, "signup:" + ip, 4, 60) || await tooMany(env, "signupall:", 25, 60)) return slowDown();
    await env.DB.prepare("DELETE FROM users WHERE pending = 1 AND active = 0 AND joined_at < datetime('now', '-2 days')").run();
    // Avec un lien d'invitation : connecté·e à qui invite. Sans : compte seul (amis à ajouter par pseudo).
    const inviter = body.invite ? await inviterOf(env, body.invite) : null;
    if (body.invite && !inviter) return Response.json({ error: "bad_invite" }, { status: 404 });
    const email = normEmail(body.email);
    const name = String(body.name ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!EMAIL_RE.test(email)) return Response.json({ error: "bad_email" }, { status: 400 });
    if (!name) return Response.json({ error: "bad_name" }, { status: 400 });
    const lang = asLang(body.lang);
    let u = await env.DB.prepare("SELECT chat_id, first_name, lang, active, pending FROM users WHERE email = ?")
      .bind(email).first<{ chat_id: number; first_name: string; lang: string | null; active: number; pending: number }>();
    if (u && !u.active && !u.pending) return Response.json({ error: "unknown_email" }, { status: 404 });   // compte fermé
    if (u?.pending) {
      await env.DB.prepare("UPDATE users SET first_name = ?, lang = ?, invited_by = ? WHERE chat_id = ?").bind(name, lang, inviter?.chat_id ?? null, u.chat_id).run();
      u = { ...u, first_name: name, lang };
    } else if (!u) {
      const chat = WEB_ID_BASE + Number(crypto.getRandomValues(new Uint32Array(2)).reduce((a, x) => a * 4096 + (x % 4096), 0));
      await env.DB.prepare("INSERT INTO users (chat_id, first_name, lang, email, active, pending, invited_by) VALUES (?, ?, ?, ?, 0, 1, ?)")
        .bind(chat, name, lang, email, inviter?.chat_id ?? null).run();
      u = { chat_id: chat, first_name: name, lang, active: 0, pending: 1 };
    }
    // Déjà inscrit·e : simple connexion (et connexion à qui invite, faite à la validation).
    else await env.DB.prepare("UPDATE users SET invited_by = COALESCE(invited_by, ?) WHERE chat_id = ? AND chat_id != ?").bind(inviter?.chat_id ?? null, u.chat_id, inviter?.chat_id ?? null).run();
    // Nouveau compte : email « confirme ton inscription » ; déjà inscrit·e : connexion habituelle. Les deux : lien + code.
    const join = !!u.pending;
    const sent = await mailCode(env, u.chat_id, email, u.first_name, asLang(u.lang), join);
    return sent instanceof Response ? sent : Response.json({ id: sent, link: join });
  }
  if (path === "/app/api/login/code") {
    const id = String(body.id ?? ""), code = String(body.code ?? "").replace(/\D/g, "");
    if (!/^[a-f0-9]{24}$/.test(id) || code.length !== 6) return Response.json({ error: "bad_request" }, { status: 400 });
    if (await tooMany(env, "code:" + ip, 30, 60)) return slowDown();
    const row = await env.DB.prepare("SELECT chat_id, code_hash, attempts FROM email_logins WHERE id = ? AND created_at > datetime('now', '-15 minutes')")
      .bind(id).first<{ chat_id: number; code_hash: string; attempts: number }>();
    if (!row || row.attempts >= 5) return Response.json({ error: "expired" }, { status: 410 });
    if ((await sha256(id + code)) !== row.code_hash) {
      await env.DB.prepare("UPDATE email_logins SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
      return Response.json({ error: "bad_code", left: 4 - row.attempts }, { status: 401 });
    }
    await env.DB.prepare("UPDATE email_logins SET attempts = 99 WHERE id = ?").bind(id).run();   // utilisé (compte encore pour la limite)
    await finishSignup(env, row.chat_id);
    return Response.json({ token: await newSession(env, row.chat_id) });
  }
  if (path === "/app/api/login/link") {
    const link = String(body.link ?? "");
    if (!/^[a-f0-9]{48}$/.test(link)) return Response.json({ error: "bad_request" }, { status: 400 });
    const h = await sha256(link);
    const row = await env.DB.prepare("SELECT id, chat_id FROM email_logins WHERE link_hash = ? AND attempts < 5 AND created_at > datetime('now', '-15 minutes')")
      .bind(h).first<{ id: string; chat_id: number }>();
    if (!row) return Response.json({ error: "expired" }, { status: 410 });
    await env.DB.prepare("UPDATE email_logins SET attempts = 99 WHERE id = ?").bind(row.id).run();
    await finishSignup(env, row.chat_id);
    return Response.json({ token: await newSession(env, row.chat_id) });
  }
  return null;
}

const KINDS = new Set(["theatre", "expo", "cinema"]);

// --- Pseudo (« @justine ») -----------------------------------------------------
const HANDLE_RE = /^[a-z0-9][a-z0-9_.]{2,19}$/;
const normHandle = (s: unknown) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();
/** Mon pseudo ; s'il n'y en a pas encore : pseudo Telegram, sinon prénom (+ chiffres si pris). */
async function ensureHandle(env: Env, chat: number): Promise<string> {
  const u = await env.DB.prepare("SELECT handle, username, first_name FROM users WHERE chat_id = ?").bind(chat)
    .first<{ handle: string | null; username: string | null; first_name: string }>();
  if (!u) return "";
  if (u.handle) return u.handle;
  const flat = (x: string) => x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_.]+/g, "").replace(/^[_.]+/, "").slice(0, 16);
  let base = flat(u.username || "") || flat(u.first_name || "");
  if (base.length < 3) base = (base + "ami").slice(0, 16);
  for (let i = 0; i < 20; i++) {
    const h = i ? `${base}${Math.floor(10 + Math.random() * 990)}` : base;
    try {
      const r = await env.DB.prepare("UPDATE users SET handle = ? WHERE chat_id = ? AND handle IS NULL").bind(h, chat).run();
      if (r.meta.changes) return h;
    } catch { /* pris : on essaie avec des chiffres */ }
  }
  return "";
}

export async function handleApp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
    return new Response(PAGE_BUILT, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const cal = url.pathname.match(/^\/app\/cal\/([A-Za-z0-9_-]{1,40})\.ics$/);
  if (req.method === "GET" && cal) return calendarFile(env, cal[1], url.searchParams.get("at") || "");
  if (req.method === "GET") return webAsset(url.pathname) ?? new Response("not found", { status: 404 });
  if (req.method === "OPTIONS") return cors(req, new Response(null, { status: 204 }));
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  return cors(req, await api(req, env, ctx, url));
}

/** « Ajouter au calendrier » : un .ics pour une séance (données publiques : titre, lieu, heure).
 *  Heure locale Berlin ; durée inconnue → 2 h 30 (théâtre) / 2 h (cinéma) ; rappel 2 h avant. */
async function calendarFile(env: Env, id: string, at: string): Promise<Response> {
  const m = at.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  const item = m && await env.DB.prepare(
    "SELECT i.id, i.kind, i.title, i.url, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id WHERE i.id = ?",
  ).bind(id).first<{ id: string; kind: string; title: string; url: string | null; venue: string }>();
  if (!m || !item) return new Response("not found", { status: 404 });
  const [, y, mo, d, h, mi] = m;
  const start = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  const end = new Date(start.getTime() + (item.kind === "cinema" ? 120 : 150) * 60000);
  const local = (t: Date) => t.toISOString().replace(/[-:]/g, "").slice(0, 13) + "00";   // « flottant » relu en Europe/Berlin
  const txt = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const fold = (l: string) => { const out: string[] = []; let b = l; while (enc.encode(b).length > 73) { let n = 73; while (enc.encode(b.slice(0, n)).length > 73) n--; out.push(b.slice(0, n)); b = " " + b.slice(n); } out.push(b); return out.join("\r\n"); };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Berlin Encore!//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", `UID:${item.id}-${at}@berlinencore.app`, `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Berlin:${local(start)}`, `DTEND;TZID=Europe/Berlin:${local(end)}`,
    `SUMMARY:${txt(`🎟 ${item.title}`)}`, `LOCATION:${txt(`${item.venue}, Berlin`)}`,
    ...(item.url ? [`URL:${item.url}`, `DESCRIPTION:${txt(item.url)}`] : []),
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${txt(item.title)}`, "TRIGGER:-PT2H", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return new Response(lines.map(fold).join("\r\n") + "\r\n", { headers: {
    "content-type": "text/calendar; charset=utf-8",
    "content-disposition": `inline; filename="berlin-encore-${item.id}.ics"`,
    "cache-control": "no-store",
  } });
}

async function api(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const body: any = await req.json().catch(() => ({}));
  const ip = req.headers.get("cf-connecting-ip") || "";
  // Face ID / empreinte : connexion sans email (passkey découvrable).
  if (url.pathname === "/app/api/passkey/login/options") {
    if (await tooMany(env, "pk:" + ip, 30, 60)) return slowDown();
    return Response.json(await loginOptions(env, req));
  }
  if (url.pathname === "/app/api/passkey/login/verify") {
    const r = await loginVerify(env, req, body);
    if ("error" in r) return Response.json(r, { status: 400 });
    return Response.json({ token: await newSession(env, r.chat) });
  }
  const pre = (await emailLogin(env, url.pathname, body, ip)) ?? (await login(env, url.pathname, body));
  if (pre) return pre;
  // Qui parle : Telegram (initData signé) ou l'app web (jeton de session).
  let uid: number | null = null, tgUser: AppUser | null = null;
  if (body.initData) {
    tgUser = await verifyInitData(String(body.initData), env.BOT_TOKEN);
    uid = tgUser?.id ?? null;
  } else {
    uid = await sessionUser(env, req, ctx);
  }
  if (!uid) return Response.json({ error: "auth" }, { status: 401 });
  if (url.pathname === "/app/api/passkey/register/options") return Response.json(await registerOptions(env, req, uid));
  if (url.pathname === "/app/api/passkey/register/verify") {
    const r = await registerVerify(env, req, uid, body);
    if (r.ok) track(env, ctx, uid, "passkey_add");
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  if (url.pathname === "/app/api/push/subscribe") {
    const ok = await subscribe(env, uid, body.subscription);
    if (ok) { track(env, ctx, uid, "push_on"); await pushTo(env, uid, { title: "Berlin Encore! 🎭", body: (await env.DB.prepare("SELECT lang FROM users WHERE chat_id = ?").bind(uid).first<{ lang: string }>())?.lang === "en" ? "Notifications are on ✓" : "Notifications activées ✓", url: "/app", tag: "welcome" }); }
    return Response.json({ ok, push: await pushCount(env, uid) }, { status: ok ? 200 : 400 });
  }
  if (url.pathname === "/app/api/push/unsubscribe") { await unsubscribe(env, uid, String(body.endpoint ?? "")); return Response.json({ push: await pushCount(env, uid) }); }
  if (url.pathname === "/app/api/push/test") {
    // Test : à moi-même, ou (admin) à un compte par email.
    let to = uid;
    if (body.email && isAdmin(env, uid)) to = (await env.DB.prepare("SELECT chat_id FROM users WHERE email = ?").bind(String(body.email).trim().toLowerCase()).first<{ chat_id: number }>())?.chat_id ?? 0;
    const sent = to ? await pushTo(env, to, { title: String(body.title || "Berlin Encore! 🎭").slice(0, 80), body: String(body.text || "Test ✓").slice(0, 200), url: "/app", tag: "test" }) : 0;
    return Response.json({ sent, devices: to ? await pushCount(env, to) : 0 });
  }
  if (url.pathname === "/app/api/passkey/list") return Response.json({ passkeys: await listPasskeys(env, uid) });
  if (url.pathname === "/app/api/passkey/remove") { await removePasskey(env, uid, String(body.id ?? "")); return Response.json({ passkeys: await listPasskeys(env, uid) }); }
  if (url.pathname === "/app/api/logout") {
    const m = (req.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
    if (m) await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash = ?").bind(await sha256(m[1])).run();
    return Response.json({ ok: true });
  }
  const me = await env.DB.prepare("SELECT chat_id, first_name, username, lang FROM users WHERE chat_id = ? AND active = 1")
    .bind(uid).first<{ chat_id: number; first_name: string; username: string | null; lang: string | null }>();
  if (!me) return Response.json({ error: "not_member", bot: env.BOT_USERNAME }, { status: 403 });
  const user: AppUser = tgUser ?? { id: me.chat_id, first_name: me.first_name, username: me.username ?? undefined };

  ctx.waitUntil(env.DB.prepare("UPDATE users SET app_seen_at = datetime('now') WHERE chat_id = ?").bind(me.chat_id).run().then(() => {}, () => {}));
  const focus = /^[\w-]{1,40}$/.test(String(body.focus ?? "")) ? String(body.focus) : "";
  if (url.pathname === "/app/api/state") {
    const recent = await env.DB.prepare("SELECT 1 FROM events WHERE chat_id = ? AND name = 'open' AND at > datetime('now', '-30 minutes')").bind(me.chat_id).first();
    if (!recent) track(env, ctx, me.chat_id, "open", null, tgUser ? "telegram" : "web");
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/track") {
    const name = String(body.name ?? ""), item = String(body.item ?? ""), target = String(body.target ?? "");
    if (!TRACKABLE.has(name)) return Response.json({ error: "bad_request" }, { status: 400 });
    track(env, ctx, me.chat_id, name, /^[\w-]{1,40}$/.test(item) ? item : null, target.replace(/[^\w.:/-]/g, "") || null);
    return Response.json({ ok: true });
  }
  if (url.pathname === "/app/api/admin") {
    if (!isAdmin(env, me.chat_id)) return Response.json({ error: "forbidden" }, { status: 403 });
    return Response.json(await adminStats(env));
  }
  if (url.pathname === "/app/api/act") {
    const op = String(body.op ?? ""), id = String(body.id ?? ""), arg = body.arg == null ? "" : String(body.arg);
    // Réglages : suivre / ne plus suivre tous les lieux d'un type (théâtres, expos, cinémas).
    if (op === "sk") {
      track(env, ctx, me.chat_id, "venue_kind_toggle", null, `${id}:${arg}`);
      if (!(KINDS.has(id) || id === "optional") || !["on", "off"].includes(arg)) return Response.json({ error: "bad_request" }, { status: 400 });
      // « Opéra & concerts » (à la carte) est une catégorie à part ; les autres excluent ces lieux.
      const which = id === "optional" ? "optional = 1 AND ?2 = ?2" : "kind = ?2 AND optional = 0";
      // Avec un quartier (Réglages filtrés) : seulement les lieux de ce type dans ce quartier.
      const area = String(body.area ?? "");
      const only = area ? JSON.stringify(Object.keys(DISTRICT).filter((v) => DISTRICT[v] === area)) : null;
      const inArea = only ? " AND id IN (SELECT value FROM json_each(?3))" : "";
      const q = arg === "on"
        ? env.DB.prepare(`INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed) SELECT ?1, id, 0 FROM venues WHERE active = 1 AND ${which}${inArea}`)
        : env.DB.prepare(`DELETE FROM subscriptions WHERE chat_id = ?1 AND venue_id IN (SELECT id FROM venues WHERE ${which}${inArea})`);
      await (only ? q.bind(me.chat_id, id, only) : q.bind(me.chat_id, id)).run();
      return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
    }
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
    track(env, ctx, me.chat_id, OP_EVENT[op] ?? op, op === "s" || op === "l" ? null : id, op === "s" ? id : op === "bd" ? `with:${Array.isArray(body.with) ? body.with.length : 0}` : arg || null);
    // La langue a pu changer (« l ») : on la relit.
    const lang = op === "l" ? asLang(id) : asLang(me.lang);
    return Response.json(await state(env, me.chat_id, lang, focus));
  }
  if (url.pathname === "/app/api/friendview") {
    const fv = await friendView(env, me.chat_id, Number(body.id), asLang(me.lang));
    return fv ? Response.json(fv) : Response.json({ error: "not_friend" }, { status: 403 });
  }
  if (url.pathname === "/app/api/handle") {
    const h = normHandle(body.handle);
    if (!HANDLE_RE.test(h)) return Response.json({ error: "bad_handle" }, { status: 400 });
    try { await env.DB.prepare("UPDATE users SET handle = ? WHERE chat_id = ?").bind(h, me.chat_id).run(); }
    catch { return Response.json({ error: "handle_taken" }, { status: 409 }); }
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/name") {
    // Mon prénom tel que les amis le voient (⭐, 💌, groupe).
    const name = String(body.name ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return Response.json({ error: "bad_name" }, { status: 400 });
    await env.DB.prepare("UPDATE users SET first_name = ? WHERE chat_id = ?").bind(name, me.chat_id).run();
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/inbox/read") {
    await env.DB.prepare("UPDATE notifications SET read_at = datetime('now') WHERE chat_id = ? AND read_at IS NULL").bind(me.chat_id).run();
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/inbox/dismiss") {
    // « Pour toi » : retirer une notification (ou toutes avec all) ; les demandes d'ami restent (elles ont leurs boutons).
    if (body.all) await env.DB.prepare("DELETE FROM notifications WHERE chat_id = ? AND kind != 'friend_request'").bind(me.chat_id).run();
    else {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "bad_request" }, { status: 400 });
      await env.DB.prepare("DELETE FROM notifications WHERE id = ? AND chat_id = ? AND kind != 'friend_request'").bind(id, me.chat_id).run();
    }
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/feedback") {
    track(env, ctx, me.chat_id, "feedback", null);
    // « Proposer un lieu » / « Un retour » : enregistré, et la propriétaire est prévenue.
    const kind = body.kind === "venue" ? "venue" : "feedback";
    const text = String(body.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 1500);
    if (text.length < 2) return Response.json({ error: "empty" }, { status: 400 });
    await env.DB.prepare("INSERT INTO feedback (chat_id, kind, text) VALUES (?, ?, ?)").bind(me.chat_id, kind, text).run();
    if (env.OWNER_CHAT_ID) {
      const who = await env.DB.prepare("SELECT first_name, handle FROM users WHERE chat_id = ?").bind(me.chat_id).first<{ first_name: string; handle: string | null }>();
      await send(env, env.OWNER_CHAT_ID, `${kind === "venue" ? "🏛 Lieu proposé" : "💬 Retour"} · <b>${esc(who?.first_name ?? "?")}</b>${who?.handle ? ` @${esc(who.handle)}` : ""}\n${esc(text)}`);
    }
    return Response.json({ ok: true });
  }
  if (url.pathname === "/app/api/photo") {
    track(env, ctx, me.chat_id, "photo", null);
    // Ma photo (data URL JPEG/PNG/WebP déjà réduite par la page ; null = retirer). Vue par mes connexions.
    const photo = body.photo == null || body.photo === "" ? null : String(body.photo);
    if (photo && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 60000))
      return Response.json({ error: "bad_photo" }, { status: 400 });
    await env.DB.prepare("UPDATE users SET photo = ? WHERE chat_id = ?").bind(photo, me.chat_id).run();
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/email") {
    // Mon adresse pour la connexion web (vide = retirer). Une adresse = un compte.
    const email = normEmail(body.email);
    if (email && !EMAIL_RE.test(email)) return Response.json({ error: "bad_email" }, { status: 400 });
    try {
      await env.DB.prepare("UPDATE users SET email = ? WHERE chat_id = ?").bind(email || null, me.chat_id).run();
    } catch { return Response.json({ error: "email_taken" }, { status: 409 }); }
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/review") {
    track(env, ctx, me.chat_id, "review", String(body.id ?? "") || null);
    // ✍️ Critique écrite dans l'app : enregistrée, rien n'est envoyé à personne.
    const id = String(body.id ?? "");
    if (!/^[\w-]{1,40}$/.test(id) || typeof body.text !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    if (!(await saveReviewFromApp(env, me.chat_id, id, body.text, ctx))) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(await state(env, me.chat_id, asLang(me.lang), focus));
  }
  if (url.pathname === "/app/api/friend") {
    // 👋 Mes amis : add (ami d'ami) | addhandle (par pseudo, à accepter) | accept | ignore | remove (sans prévenir).
    if (body.op === "invite") {
      // Déjà connecté·e et on ouvre le lien d'invitation de quelqu'un : connectés directement.
      const inviter = await inviterOf(env, body.code);
      if (!inviter) return Response.json({ error: "bad_invite" }, { status: 404 });
      const result = inviter.chat_id === me.chat_id ? "self" : "connected";
      if (inviter.chat_id !== me.chat_id) { await connect(env, me.chat_id, inviter.chat_id); await loadCircles(env); }
      return Response.json({ result, inviter: inviter.first_name, ...(await state(env, me.chat_id, asLang(me.lang), focus)) });
    }
    if (body.op === "addhandle") {
      const h = normHandle(body.handle);
      const u = h ? await env.DB.prepare("SELECT chat_id FROM users WHERE handle = ? AND active = 1").bind(h).first<{ chat_id: number }>() : null;
      if (!u) return Response.json({ error: "no_handle" }, { status: 404 });
      const result = await requestFriend(env, me.chat_id, u.chat_id, true);
      await loadCircles(env);
      return Response.json({ result, ...(await state(env, me.chat_id, asLang(me.lang), focus)) });
    }
    const op = String(body.op ?? ""), other = Number(body.id);
    if (!Number.isFinite(other) || other === me.chat_id) return Response.json({ error: "bad_request" }, { status: 400 });
    let result: string = "ok";
    track(env, ctx, me.chat_id, "friend_" + op, null, null);
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
    track(env, ctx, me.chat_id, "share", id, `to:${to.length}${note ? ":note" : ""}`);
    return Response.json({ sent, ...(await state(env, me.chat_id, asLang(me.lang), focus)) });
  }
  return new Response("not found", { status: 404 });
}

/** Page d'accueil (non connecté·e) : quelques séances des 7 prochains jours, données publiques du programme. */
async function teaser(env: Env) {
  const since = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'current_since'").first<{ value: string }>())?.value ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.kind, i.title, i.dates, i.sold, i.starred, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE i.kind != 'expo' AND (i.kind = 'film' OR i.last_seen >= ?) LIMIT 400`,
  ).bind(since).all<any>();
  const now = new Date(Date.now() + 3600e3).toISOString().slice(0, 16).replace("T", " ");   // ≈ heure de Berlin
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const rows = results.map((i) => {
    const sold = new Set(JSON.parse(i.sold || "[]"));
    const at = (JSON.parse(i.dates || "[]") as string[]).filter((d) => d >= now && d.slice(0, 10) <= week && !sold.has(d)).sort()[0];
    return at ? { kind: i.kind === "film" ? "cinema" : i.kind, title: i.title, venue: i.venue, at, starred: i.starred } : null;
  }).filter(Boolean) as any[];
  // Un mélange : théâtre d'abord (le cœur), puis ciné ; les ⭐ du moment en tête ; un titre par lieu.
  rows.sort((a, b) => (b.starred - a.starred) || (a.kind === "theatre" ? -1 : 0) - (b.kind === "theatre" ? -1 : 0) || a.at.localeCompare(b.at));
  const seen = new Set<string>(), out: any[] = [];
  for (const r of rows) { if (seen.has(r.venue)) continue; seen.add(r.venue); out.push(r); if (out.length === 8) break; }
  return { items: out.sort((a, b) => a.at.localeCompare(b.at)).map(({ starred, ...r }) => r) };
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
        OR i.id IN (SELECT item_id FROM notifications WHERE chat_id = ?1 AND item_id IS NOT NULL AND created_at > datetime('now', '-30 days'))
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
    `SELECT v.id, v.name, v.kind, v.optional, EXISTS (SELECT 1 FROM subscriptions s WHERE s.chat_id = ? AND s.venue_id = v.id) AS followed
     FROM venues v WHERE v.active = 1 ORDER BY CASE v.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position`,
  ).bind(chat).all<any>();
  // « Envoyer à » / « + Joss » : mes connexions seulement.
  const circle = await circleState(env, chat);
  const people = circle.friends;
  const invite = await inviteMessage(env, chat, lang);
  // Prochaines ouvertes de billetterie (src/sales.py), pour les lieux que je suis.
  const salesRaw = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'sales'").first<{ value: string }>())?.value;
  let sales: { venue: string; day: string; at: string | null; month: string }[] = [];
  try {
    const names = new Map(venues.filter((v: any) => v.followed).map((v: any) => [v.id, v.name]));
    sales = Object.values(JSON.parse(salesRaw || "{}") as Record<string, any>)
      .filter((x) => names.has(x.venue_id) && x.day >= new Date().toISOString().slice(0, 10))
      .map((x) => ({ venue: String(names.get(x.venue_id)), day: x.day, at: x.hour_known && x.at ? String(x.at).slice(11, 16) : null, month: x.month }))
      .sort((a, b) => a.day.localeCompare(b.day));
  } catch { /* calendrier illisible : on n'affiche rien */ }
  const handle = await ensureHandle(env, chat);
  const meRow = await env.DB.prepare("SELECT email, first_name, photo FROM users WHERE chat_id = ?").bind(chat).first<{ email: string | null; first_name: string; photo: string | null }>();
  // Photos de mes connexions (et la mienne) : la page les met à la place des prénoms.
  const { results: pics } = await env.DB.prepare(
    "SELECT chat_id, photo FROM users WHERE photo IS NOT NULL AND active = 1 AND chat_id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify([chat, ...circle.friends.map((f: any) => f.id)])).all<{ chat_id: number; photo: string }>();
  const myEmail = meRow?.email ?? null;
  const { results: notes } = await env.DB.prepare(
    `SELECT n.id, n.kind, n.from_id, u.first_name AS from_name, n.item_id, i.title, n.note, n.at, n.created_at, n.read_at
     FROM notifications n LEFT JOIN users u ON u.chat_id = n.from_id LEFT JOIN items i ON i.id = n.item_id
     WHERE n.chat_id = ? ORDER BY n.id DESC LIMIT 40`).bind(chat).all<any>();
  return {
    lang,
    admin: isAdmin(env, chat) || undefined,
    vapid: env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY : undefined,
    push: await pushCount(env, chat),
    inbox: notes,
    email: myEmail,
    name: meRow?.first_name ?? "",
    handle,
    photo: meRow?.photo ?? null,
    photos: Object.fromEntries(pics.map((p) => [p.chat_id, p.photo])),
    sales,
    venues: venues.map((v: any) => ({ ...v, district: DISTRICT[v.id] ?? null, logo: LOGOS[v.id] ? `/app/logo/${v.id}.png` : null })),
    people,
    circle,
    invite: (invite.match(/https:\/\/\S+/) || [""])[0],   // le lien seul (le message autour est pour le chat)
    items: items.map((i) => shapeItem(i, mine.get(i.id), friends.get(i.id) ?? [], lang)),
  };
}

/** Une fiche telle que la page l'affiche (programme, Mes sorties, page d'un ami). */
function shapeItem(i: any, r: any, friends: any[], lang: Lang) {
  return {
    id: i.id, kind: i.kind, title: i.title, url: i.url, venue: i.venue, venue_id: i.venue_id,
    dates: JSON.parse(i.dates || "[]"), sold: JSON.parse(i.sold || "[]"), start: i.start_date, end: i.end_date, starred: i.starred,
    text: itemText(i, lang),
    me: r ? { star: r.interested, status: r.status, rating: r.rating, comment: r.comment, booked: r.booked_at, at: r.updated_at } : null,
    friends,
  };
}

/** Page d'un ami (connexion seulement) : ses ⭐, ses places 🎟 à venir et ce qu'il a vu, avec mes réactions. */
async function friendView(env: Env, me: number, other: number, lang: Lang) {
  if (other === me || !inCircle(me, other)) return null;
  const u = await env.DB.prepare("SELECT first_name FROM users WHERE chat_id = ? AND active = 1").bind(other).first<{ first_name: string }>();
  if (!u) return null;
  const { results } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue, r.interested, r.status, r.rating, r.comment, r.booked_at, r.updated_at
     FROM reactions r JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND (r.interested = 1 OR r.status = 'seen' OR r.booked_at IS NOT NULL)
       AND (r.status IS NULL OR r.status != 'ignored')
     ORDER BY r.updated_at DESC LIMIT 200`,
  ).bind(other).all<any>();
  const ids = JSON.stringify(results.map((x) => x.id));
  const { results: minesRows } = await env.DB.prepare(
    "SELECT * FROM reactions WHERE chat_id = ? AND item_id IN (SELECT value FROM json_each(?))").bind(me, ids).all<any>();
  const mine = new Map(minesRows.map((r) => [r.item_id, r]));
  return {
    id: other, name: u.first_name,
    items: results.map((x) => shapeItem(x, mine.get(x.id), [{
      id: other, name: u.first_name, star: x.interested && x.status !== "seen" ? 1 : 0, booked: x.booked_at,
      seen: x.status === "seen" ? 1 : 0, rating: x.rating, comment: x.comment, at: x.updated_at,
    }], lang)),
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
    await inbox(env, u.chat_id, "share", me.chat_id, id, note || null);
    await send(env, u.chat_id, `${head}\n\n${itemText(item, lang) ?? esc(item.title)}`, keyboard(item, r, lang));
    out.push(u.first_name);   // 🔔 dans l'app dans tous les cas (Telegram en plus si la personne l'a)
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
    await inbox(env, u.chat_id, "booked", me.chat_id, id, null, iso);
    await send(env, u.chat_id, MSG[lang].booked(esc(me.first_name), esc(item.title), whenLabel(iso, lang)), keyboard(item, r, lang));
  }
}

/** Admin (la propriétaire seulement) : inscrits, activité, robots bloqués, derniers retours. */
const isAdmin = (env: Env, chat: number) => !!env.OWNER_CHAT_ID && String(chat) === String(env.OWNER_CHAT_ID);
async function adminStats(env: Env) {
  const one = async (q: string) => (await env.DB.prepare(q).first<{ n: number }>())?.n ?? 0;
  const [users, weeks, blocked, feedback] = await Promise.all([
    env.DB.prepare(`SELECT u.chat_id, u.first_name, u.handle, u.email, u.lang, u.active, u.pending, u.joined_at,
        MAX(COALESCE(u.app_seen_at, ''), COALESCE(u.bot_seen_at, '')) AS seen_at, u.photo IS NOT NULL AS has_photo,
        (SELECT COUNT(*) FROM connections c WHERE (c.a = u.chat_id OR c.b = u.chat_id) AND c.status = 'ok') AS friends,
        (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.interested = 1) AS wants,
        (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.booked_at IS NOT NULL) AS booked,
        (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.status = 'seen') AS seen,
        (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id) AS venues
      FROM users u ORDER BY u.joined_at DESC LIMIT 500`).all<any>(),
    env.DB.prepare(`SELECT strftime('%Y-%W', joined_at) AS wk, MIN(date(joined_at)) AS from_day, COUNT(*) AS n
      FROM users WHERE active = 1 AND joined_at > datetime('now', '-84 days') GROUP BY wk ORDER BY wk`).all<any>(),
    env.DB.prepare(`SELECT substr(key, 9) AS kind, COUNT(*) AS n FROM rate_hits WHERE key LIKE 'blocked:%' AND at > datetime('now', '-1 day') GROUP BY kind`).all<any>(),
    env.DB.prepare(`SELECT f.kind, f.text, f.created_at, u.first_name FROM feedback f LEFT JOIN users u ON u.chat_id = f.chat_id ORDER BY f.id DESC LIMIT 20`).all<any>(),
  ]);
  return {
    totals: {
      active: await one("SELECT COUNT(*) n FROM users WHERE active = 1"),
      pending: await one("SELECT COUNT(*) n FROM users WHERE pending = 1 AND active = 0"),
      web: await one(`SELECT COUNT(*) n FROM users WHERE active = 1 AND chat_id >= ${WEB_ID_BASE}`),
      new7: await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND joined_at > datetime('now', '-7 days')"),
      seen7: await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND MAX(COALESCE(app_seen_at, ''), COALESCE(bot_seen_at, '')) > datetime('now', '-7 days')"),
      mails24: await one("SELECT COUNT(*) n FROM rate_hits WHERE key = 'mail:' AND at > datetime('now', '-1 day')"),
    },
    weeks: weeks.results, blocked: blocked.results, feedback: feedback.results,
    ...(await adminUsage(env)),
    users: users.results.map((u: any) => ({ ...u, web: u.chat_id >= WEB_ID_BASE, chat_id: undefined })),
  };
}

/** Admin : usage (réactions, lieux suivis, ce qui plaît), comptes actifs seulement. */
async function adminUsage(env: Env) {
  const act = "chat_id IN (SELECT chat_id FROM users WHERE active = 1)";
  const [reac, subs, venues, top, last7] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(interested = 1), 0) AS wants, COALESCE(SUM(booked_at IS NOT NULL), 0) AS booked, COALESCE(SUM(status = 'seen'), 0) AS seen,
        COALESCE(SUM(status = 'ignored'), 0) AS ignored, COALESCE(SUM(rating IS NOT NULL), 0) AS rated, ROUND(AVG(rating), 1) AS avg_rating,
        COALESCE(SUM(comment IS NOT NULL AND comment != ''), 0) AS reviews, COUNT(DISTINCT chat_id) AS users
      FROM reactions WHERE ${act}`).first<any>(),
    env.DB.prepare(`SELECT ROUND(AVG(n), 1) AS avg, MIN(n) AS min, MAX(n) AS max FROM
      (SELECT u.chat_id, (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id) AS n FROM users u WHERE u.active = 1)`).first<any>(),
    env.DB.prepare(`SELECT v.name, v.kind, v.optional, COUNT(s.chat_id) AS n FROM venues v
      LEFT JOIN subscriptions s ON s.venue_id = v.id AND s.${act}
      WHERE v.active = 1 GROUP BY v.id ORDER BY n DESC, v.name`).all<any>(),
    env.DB.prepare(`SELECT i.title, v.name AS venue, COALESCE(SUM(r.interested = 1), 0) AS wants, COALESCE(SUM(r.booked_at IS NOT NULL), 0) AS booked,
        COALESCE(SUM(r.status = 'seen'), 0) AS seen, COALESCE(SUM(r.status = 'ignored'), 0) AS ignored
      FROM reactions r JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
      WHERE r.${act} GROUP BY r.item_id ORDER BY wants + booked * 2 + seen DESC LIMIT 12`).all<any>(),
    env.DB.prepare(`SELECT COALESCE(SUM(interested = 1), 0) AS wants, COALESCE(SUM(booked_at IS NOT NULL), 0) AS booked, COALESCE(SUM(status = 'seen'), 0) AS seen, COALESCE(SUM(status = 'ignored'), 0) AS ignored
      FROM reactions WHERE ${act} AND updated_at > datetime('now', '-7 days')`).first<any>(),
  ]);
  const [ev, links] = await Promise.all([
    env.DB.prepare(`SELECT name, COUNT(*) AS n, COUNT(DISTINCT chat_id) AS u, SUM(at > datetime('now', '-7 days')) AS n7
      FROM events WHERE at > datetime('now', '-30 days') AND (chat_id IS NULL OR chat_id != ?) GROUP BY name ORDER BY n DESC`).bind(Number(env.OWNER_CHAT_ID || 0)).all<any>(),
    env.DB.prepare(`SELECT target, COUNT(*) AS n FROM events WHERE name = 'link_out' AND at > datetime('now', '-30 days') AND (chat_id IS NULL OR chat_id != ?)
      GROUP BY target ORDER BY n DESC LIMIT 10`).bind(Number(env.OWNER_CHAT_ID || 0)).all<any>(),
  ]);
  return { usage: { ...reac, last7, subs }, venues: venues.results, top: top.results, events: ev.results, links: links.results };
}
