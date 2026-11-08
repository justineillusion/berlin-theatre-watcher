// Briques communes : types, accès D1, Telegram, rendu des messages.
import { Lang, tr } from "./i18n";

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;       // token @BotFather (secret)
  API_TOKEN: string;       // partagé avec le scraper GitHub Actions (secret)
  WEBHOOK_SECRET: string;  // vérifie que les updates viennent bien de Telegram (secret)
  OWNER_CHAT_ID: string;   // ton chat_id : admin du bot
  BOT_USERNAME: string;    // sans @, pour le lien d'invitation
  APP_SHORT_NAME?: string; // mini-app (BotFather), défaut « Programme »
  TG_API?: string;         // tests uniquement (faux Telegram local)
}

export interface Item {
  id: string;
  venue_id: string;
  kind: "theatre" | "expo" | "film";
  title: string;
  url: string | null;
  dates: string;           // JSON
  start_date: string | null;
  end_date: string | null;
  starred: number;
  text: string | null;
  line: string | null;
  text_en: string | null;  // variantes anglaises (users.lang = 'en'), NULL = pas rendues
  line_en: string | null;
}

/** Corps / ligne de récap d'un item dans la langue de la personne (repli : français). */
export const itemText = (item: Item, lang: Lang) => (lang === "en" && item.text_en) || item.text;
export const itemLine = (item: Item, lang: Lang) =>
  (lang === "en" && item.line_en) || item.line || basicLine(item, lang);

/** Horizon d'affichage (config.yaml → /api/plan → settings) : on ne montre que
 *  ce qui se joue MAINTENANT ou bientôt. Expos : ouvertes, ou qui ouvrent sous
 *  `expo` jours ; pièces : une date dans les `theatre` jours (et seulement
 *  celles-là). Au-delà, l'item est gardé en base sans bruit et annoncé quand il
 *  entre dans la fenêtre. */
export interface Horizon { expo: number; theatre: number }
let HORIZON: Horizon = { expo: 7, theatre: 14 };
const days = (v: string | null, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 3650 ? n : d;
};
export async function horizon(env: Env): Promise<Horizon> {
  HORIZON = {
    expo: days(await setting(env, "horizon_expo_days"), 7),
    theatre: days(await setting(env, "horizon_theatre_days"), 14),
  };
  return HORIZON;
}
/** Dernier jour (AAAA-MM-JJ) de la fenêtre des pièces / des expos. */
export const windowEnd = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
/** Dates d'une pièce dans la fenêtre. */
export const inWindow = (dates: string[], h: Horizon = HORIZON) => {
  const now = new Date().toISOString().slice(0, 10), end = windowEnd(h.theatre);
  return dates.filter((x) => x.slice(0, 10) >= now && x.slice(0, 10) <= end).sort();
};
/** Condition SQL « dans la fenêtre » pour l'item `a` (films : gérés à part). */
export const windowSql = (h: Horizon, a = "i") => `(CASE ${a}.kind
  WHEN 'expo' THEN (${a}.start_date IS NULL OR ${a}.start_date = '' OR ${a}.start_date <= date('now', '+${h.expo} days'))
  WHEN 'theatre' THEN EXISTS (SELECT 1 FROM json_each(${a}.dates)
    WHERE substr(value, 1, 10) BETWEEN date('now') AND date('now', '+${h.theatre} days'))
  ELSE 1 END)`;

/** Ligne minimale quand le scraper n'a pas (encore) rédigé l'item : titre lié + dates. */
export function basicLine(item: Item, lang: Lang): string {
  const t = item.url ? `<a href="${esc(item.url)}">${esc(item.title)}</a>` : esc(item.title);
  const star = item.starred ? " ⭐" : "";
  let when = "";
  if (item.kind === "expo") {
    if (item.end_date) when = `${lang === "en" ? "until" : "jusqu'au"} ${frDate(item.end_date)}`;
  } else {
    const now = new Date().toISOString().slice(0, 10);
    const all = (JSON.parse(item.dates || "[]") as string[]).filter((x) => x.slice(0, 10) >= now).sort();
    const d = item.kind === "theatre" ? inWindow(all) : all;
    if (d.length) when = d.slice(0, 5).map((x) => frDate(x)).join(", ") + (d.length > 5 ? ` (+${d.length - 5})` : "");
  }
  return `• ${t}${star}${when ? `\n   🗓 ${when}` : ""}`;
}

export interface Reaction {
  chat_id: number;
  item_id: string;
  interested: number;
  status: "seen" | "ignored" | null;
  rating: number | null;
  comment: string | null;
  booked_at?: string | null;
  booked_on?: string | null;
  followup_sent?: number;
}

export interface Friend extends Reaction {
  first_name: string;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
export async function tg(env: Env, method: string, body: unknown): Promise<any> {
  const base = env.TG_API || "https://api.telegram.org";
  const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await resp.json().catch(() => ({ ok: false }));
  if (!data.ok && !String(data.description || "").includes("message is not modified")) {
    console.log(`tg ${method} failed: ${data.description || resp.status}`);
  }
  return data;
}

export const send = (env: Env, chat_id: number | string, text: string, reply_markup?: unknown) =>
  tg(env, "sendMessage", {
    chat_id, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  });

export const edit = (env: Env, chat_id: number | string, message_id: number, text: string, reply_markup?: unknown) =>
  tg(env, "editMessageText", {
    chat_id, message_id, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: reply_markup ?? { inline_keyboard: [] },
  });

export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------
export async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(key, value).run();
  }
}

export async function getItem(env: Env, id: string): Promise<Item | null> {
  return env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
}

export async function getReaction(env: Env, chat_id: number, item_id: string): Promise<Reaction | null> {
  return env.DB.prepare("SELECT * FROM reactions WHERE chat_id = ? AND item_id = ?")
    .bind(chat_id, item_id).first<Reaction>();
}

// ---------------------------------------------------------------------------
// Cercles : chacun ne voit les ⭐ 🎟 ✅ que de ses connexions (table connections).
// Chargé une fois par requête (index.ts) ; non chargé = on ne montre personne (fermé par défaut).
// ---------------------------------------------------------------------------
let CIRCLES: Map<number, Set<number>> | null = null;
export async function loadCircles(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT a, b FROM connections WHERE status = 'ok'").all<{ a: number; b: number }>();
  const m = new Map<number, Set<number>>();
  const add = (x: number, y: number) => (m.get(x) ?? m.set(x, new Set()).get(x)!).add(y);
  for (const r of results) { add(r.a, r.b); add(r.b, r.a); }
  CIRCLES = m;
}
/** `other` fait-il partie du cercle de `viewer` (ou est-ce lui-même) ? */
export const inCircle = (viewer: number, other: number) => viewer === other || !!CIRCLES?.get(viewer)?.has(other);
/** Les réactions visibles par `viewer`. Sans viewer (groupe, récap commun) : pas de filtre. */
export const visibleTo = <T extends { chat_id: number }>(friends: T[], viewer: number | null) =>
  viewer == null ? friends : friends.filter((f) => inCircle(viewer, f.chat_id));
/** SQL : `col` est dans le cercle de la personne liée en `?n` (elle-même comprise). */
export const circleSql = (col: string, param: string) => `(${col} = ${param} OR ${col} IN (
  SELECT b FROM connections WHERE a = ${param} AND status = 'ok' UNION SELECT a FROM connections WHERE b = ${param} AND status = 'ok'))`;

/** Réactions des personnes ACTIVES à un ensemble d'items (pour les pieds de message). */
export async function friendsByItem(env: Env, itemIds: string[]): Promise<Map<string, Friend[]>> {
  const out = new Map<string, Friend[]>();
  if (!itemIds.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT r.*, u.first_name FROM reactions r JOIN users u ON u.chat_id = r.chat_id
     WHERE u.active = 1 AND r.item_id IN (SELECT value FROM json_each(?))
       AND (r.interested = 1 OR r.status = 'seen')
     ORDER BY r.updated_at`,
  ).bind(JSON.stringify(itemIds)).all<Friend>();
  for (const f of results) {
    if (!out.has(f.item_id)) out.set(f.item_id, []);
    out.get(f.item_id)!.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
export function stars(n: number): string {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function frDate(iso: string | null): string {
  if (!iso || iso.length < 10) return iso ?? "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

const name = (f: Friend, viewer: number | null, lang: Lang) => (f.chat_id === viewer ? tr(lang).you : esc(f.first_name));

/** Bloc « 👥 La bande » : qui est intéressé, qui a vu et ce qu'ils en ont pensé. */
export function socialBlock(friends: Friend[], viewer: number | null, compact = false, lang: Lang = "fr"): string {
  const T = tr(lang);
  const nm = (f: Friend) => name(f, viewer, lang);
  const interested = friends.filter((f) => f.interested && f.status !== "seen" && f.status !== "ignored");
  const seen = friends.filter((f) => f.status === "seen");
  if (!interested.length && !seen.length) return "";

  const rated = seen.filter((f) => f.rating);
  const avg = rated.length ? rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length : 0;

  if (compact) {
    const parts: string[] = [];
    if (interested.length) parts.push(`⭐ ${interested.map(nm).join(", ")}`);
    if (rated.length) parts.push(T.avgCompact(stars(Math.round(avg)), rated.length));
    else if (seen.length) parts.push(T.seenBy(seen.map(nm).join(", ")));
    return `   👥 ${parts.join(" · ")}`;
  }

  const lines = ["\n" + T.band];
  if (interested.length) lines.push(T.interested(interested.map(nm).join(", ")));
  if (seen.length) {
    if (rated.length > 1) {
      const a = avg.toFixed(1);
      lines.push(T.avg(stars(Math.round(avg)), lang === "fr" ? a.replace(".", ",") : a, rated.length));
    }
    for (const f of seen.slice(-6)) {
      const note = f.rating ? ` ${stars(f.rating)}` : "";
      const word = f.comment ? ` — « ${esc(f.comment.slice(0, 140))} »` : "";
      lines.push(`✅ ${nm(f)}${note}${word}`);
    }
  }
  return lines.join("\n");
}

/** Boutons sous une notif, selon l'état de la personne qui la regarde. */
/** Jour de Berlin, « 2026-11-08 ». */
export const berlinDay = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** À l'affiche aujourd'hui (on a pu le voir ailleurs) : expo ouverte ; pièce/film commencé·e et encore programmé·e. */
export function isShowing(item: Item, today = berlinDay()): boolean {
  if (item.start_date && item.start_date.slice(0, 10) > today) return false;
  if (item.kind === "expo") return !item.end_date || item.end_date.slice(0, 10) >= today;
  const dates = (JSON.parse(item.dates || "[]") as string[]).map((d) => d.slice(0, 10));
  return dates.some((d) => d >= today);
}

/** Boutons = la prochaine étape seulement (machine à états, docs/ux.md) :
 *  proposé  [⭐ Intéressé·e] [🙅 Pas pour moi] (+ [✅ Déjà vu] si à l'affiche)
 *  ⭐       [🎟 Réserver] [✅ Déjà vu] / [↩︎ annuler ⭐]
 *  🎟       [📅 Changer la date] ; dès le lendemain de la date : [★ Noter]
 *  ✅       1★…5★ ; noté : [✍️ Critique] tant qu'il n'y a pas d'avis, puis rien
 *  🙅       [↩︎ Annuler] */
export function keyboard(item: Item, r: Reaction | null, lang: Lang = "fr"): unknown {
  const id = item.id;
  const T = tr(lang);
  const kb = (...rows: { text: string; callback_data: string }[][]) => ({ inline_keyboard: rows });
  if (r?.status === "ignored") return kb([{ text: T.btnUndo, callback_data: `u:${id}` }]);
  if (r?.status === "seen") {
    if (!r.rating) return kb([1, 2, 3, 4, 5].map((n) => ({ text: `${n}★`, callback_data: `r:${id}:${n}` })));
    return r.comment
      ? kb([{ text: T.btnEdit, callback_data: `ed:${id}` }])
      : kb([{ text: T.btnCritique, callback_data: `w:${id}` }]);
  }
  if (r?.booked_at) {
    return r.booked_at.slice(0, 10) < berlinDay()
      ? kb([{ text: T.btnRate, callback_data: `v:${id}` }])
      : kb([{ text: T.btnChangeDate, callback_data: `b:${id}` }]);
  }
  if (r?.interested) {
    return kb(
      [{ text: T.btnReserve, callback_data: `b:${id}` }, { text: T.btnAlreadySeen, callback_data: `v:${id}` }],
      [{ text: T.btnUnstar, callback_data: `i:${id}` }],
    );
  }
  const row = [
    { text: T.btnInterested, callback_data: `i:${id}` },
    { text: T.btnIgnore, callback_data: `x:${id}` },
  ];
  if (isShowing(item)) row.push({ text: T.btnAlreadySeen, callback_data: `v:${id}` });
  return kb(row);
}

/** ✏️ Modifier (noté + avis) : 1–5★ (note actuelle marquée), [✍️ Réécrire la critique] [↩︎ Retour]. */
export function editKeyboard(item: Item, r: Reaction | null, lang: Lang = "fr"): unknown {
  const T = tr(lang);
  return { inline_keyboard: [
    [1, 2, 3, 4, 5].map((n) => ({ text: r?.rating === n ? `· ${n}★ ·` : `${n}★`, callback_data: `r:${item.id}:${n}` })),
    [{ text: T.btnRewrite, callback_data: `w:${item.id}` }, { text: T.btnBack, callback_data: `eb:${item.id}` }],
  ] };
}

/** « sam. 9 janv. 19:30 » / « Sat 9 Jan 19:30 » (date seule : sans l'heure). */
export function whenLabel(iso: string, lang: Lang): string {
  const T = tr(lang);
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  if (isNaN(d.getTime())) return iso;
  const time = iso.length > 10 && iso.slice(11, 16) !== "00:00" ? ` ${iso.slice(11, 16)}` : "";
  return `${T.days[d.getUTCDay()]} ${d.getUTCDate()} ${T.months[d.getUTCMonth()]}${time}`;
}

function statusLine(item: Item, r: Reaction | null, lang: Lang): string {
  const T = tr(lang);
  const expo = item.kind === "expo";
  if (r?.status === "ignored") return T.stIgnored(expo);
  if (r?.status === "seen") {
    return r.rating ? T.stRated(stars(r.rating), r.comment ? esc(r.comment.slice(0, 140)) : "") : T.stSeen(expo);
  }
  if (r?.booked_at) return T.stBooked(whenLabel(r.booked_at, lang));
  return "";
}

/** Corps minimal d'une notif quand le texte n'a pas (encore) été rédigé. */
export function basicText(item: Item, lang: Lang): string {
  const icon = item.kind === "expo" ? "🖼" : item.kind === "film" ? "🎬" : "🎭";
  const lines = basicLine(item, lang).split("\n").slice(1).map((l) => l.trim());
  const link = item.url ? `\n🔗 <a href="${esc(item.url)}">${lang === "en" ? "Details" : "Détails"}</a>` : "";
  return `${icon} <b>${esc(item.title)}</b>${lines.length ? "\n" + lines.join("\n") : ""}${link}`;
}

const MAX = 4000;

/** Coupe propre : retire une balise entamée et referme les balises restées ouvertes (HTML Telegram). */
export function closeHtml(s: string): string {
  s = s.replace(/<[^>]*$/, "").replace(/&[a-z#0-9]*$/i, "");
  const open: string[] = [];
  for (const m of s.matchAll(/<(\/?)([a-z]+)[^>]*>/gi)) {
    const tag = m[2].toLowerCase();
    if (m[1]) { const i = open.lastIndexOf(tag); if (i >= 0) open.splice(i, 1); }
    else open.push(tag);
  }
  return s + open.reverse().map((t) => `</${t}>`).join("");
}

/** Message complet pour une personne : en-tête + corps + bande + état. */
export function renderFor(
  item: Item, viewer: number, r: Reaction | null, friends: Friend[], header: string | null, lang: Lang = "fr",
): { text: string; reply_markup: unknown } {
  const body = itemText(item, lang) || basicText(item, lang);
  const tail = socialBlock(visibleTo(friends, viewer), viewer, false, lang) + statusLine(item, r, lang);
  let text = (header ? `${header}\n` : "") + body;
  if (text.length + tail.length > MAX) text = closeHtml(text.slice(0, MAX - tail.length - 30) + "…");
  return { text: text + tail, reply_markup: keyboard(item, r, lang) };
}

/** Lien qui ouvre la mini-app sur une fiche (marche aussi dans le groupe, où les boutons web_app sont interdits). */
export const appHome = (env: Env) => `https://t.me/${env.BOT_USERNAME}/${env.APP_SHORT_NAME || "Programme"}`;
export const appLink = (env: Env, itemId: string) =>
  `https://t.me/${env.BOT_USERNAME}/${env.APP_SHORT_NAME || "Programme"}?startapp=${itemId}`;
