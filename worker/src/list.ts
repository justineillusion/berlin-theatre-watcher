// Liste dépliable : UN message par surface (/sorties, lot du matin, /programme, récap du dimanche).
//   liste : en-tête + une ligne compacte par item (« 🎭 Titre — Lieu · ★★★½ · ⭐ »), un bouton par item,
//           pagination [◀] [n/m] [▶] (8 par page) ;
//   fiche : le MÊME message devient la fiche complète (boutons d'état) + [↩︎ Liste] ; les actions
//           (⭐, 🎟, ★…) éditent ce message ; ↩︎ revient à la liste, même page, ligne à jour.
// L'état d'une liste vit dans settings (« list:<chat>:<message> »).
import { Lang, tr } from "./i18n";
import {
  Env, Horizon, Item, Reaction, edit, esc, friendsByItem, horizon, renderFor, send, setSetting, setting, stars, whenLabel,
  windowSql,
} from "./lib";

export const PAGE_SIZE = 8;
const ICON: Record<string, string> = { theatre: "🎭", expo: "🖼", film: "🎬" };
const short = (t: string, n = 30) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

export interface Entry { id: string; section: string; header?: string | null }
export interface ListState {
  k: "sorties" | "batch" | "prog" | "sunday";
  p: number;                     // page
  f?: string;                    // filtre (/programme : all | theatre | expo | film)
  open?: string | null;          // item déplié (mode fiche)
  head?: string;                 // texte fixe au-dessus des lignes (récap du dimanche)
  titles?: Record<string, string>; // titre d'une section stockée (ex. en-tête ciné)
  items?: Entry[];               // listes figées (lot, dimanche) ; sinon recalculées
}

const key = (chat: number, msg: number) => `list:${chat}:${msg}`;
export async function getList(env: Env, chat: number, msg: number): Promise<ListState | null> {
  const v = await setting(env, key(chat, msg));
  return v ? JSON.parse(v) : null;
}
export const saveList = (env: Env, chat: number, msg: number, s: ListState) => setSetting(env, key(chat, msg), JSON.stringify(s));

/** /sorties : 🎟 réservé (date ↑), ⭐ intéressé·e, ✅ vu (10 derniers). Recalculé à chaque rendu. */
async function sortiesEntries(env: Env, chat: number): Promise<Entry[]> {
  const since = (await setting(env, "current_since")) ?? "";
  const { results: active } = await env.DB.prepare(
    `SELECT i.id, r.booked_at FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE r.chat_id = ?1 AND r.interested = 1 AND r.status IS NULL
       AND (r.booked_at IS NOT NULL AND substr(r.booked_at, 1, 10) >= date('now')
            OR CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                    ELSE i.last_seen >= datetime(?2, '-2 days') END)
     ORDER BY r.booked_at IS NULL, r.booked_at, i.title LIMIT 40`,
  ).bind(chat, since).all<{ id: string; booked_at: string | null }>();
  const { results: seen } = await env.DB.prepare(
    "SELECT item_id AS id FROM reactions WHERE chat_id = ? AND status = 'seen' ORDER BY updated_at DESC LIMIT 10",
  ).bind(chat).all<{ id: string }>();
  return [
    ...active.map((r) => ({ id: r.id, section: r.booked_at ? "booked" : "keen" })),
    ...seen.map((r) => ({ id: r.id, section: "seen" })),
  ];
}

/** Items « à l'affiche » vus par `chat` (?1) : lieux suivis, encore programmés (?2 = current_since).
 *  `keepStarred` : les ⭐ restent (la ligne porte « ⭐ ») ; vu / 🙅 sortent toujours. */
export const currentSql = (h: Horizon, keepStarred = false) => `
  ${windowSql(h)} AND
  i.venue_id IN (SELECT venue_id FROM subscriptions WHERE chat_id = ?1)
  AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
            ELSE i.last_seen >= ?2 END)
  AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= date('now'))
  AND NOT EXISTS (SELECT 1 FROM reactions x WHERE x.item_id = i.id AND x.chat_id = ?1
                  AND (x.status IS NOT NULL ${keepStarred ? "" : "OR x.interested = 1"}))`;

/** /programme : tout ce qui est à l'affiche dans mes lieux (⭐ compris), par type, filtrable. */
async function progEntries(env: Env, chat: number, f = "all"): Promise<Entry[]> {
  const since = (await setting(env, "current_since")) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.kind FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE ${currentSql(await horizon(env), true)} AND (?3 = 'all' OR i.kind = ?3)
     ORDER BY CASE i.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position,
       COALESCE(NULLIF(i.start_date, ''), json_extract(i.dates, '$[0]'), '9999'), i.title LIMIT 300`,
  ).bind(chat, since, f).all<{ id: string; kind: string }>();
  return results.map((r) => ({ id: r.id, section: r.kind }));
}

async function entriesFor(env: Env, chat: number, s: ListState): Promise<Entry[]> {
  if (s.k === "sorties") return sortiesEntries(env, chat);
  if (s.k === "prog") return progEntries(env, chat, s.f ?? "all");
  return s.items ?? [];
}

function sectionTitle(s: ListState, section: string, n: number, lang: Lang): string {
  const T = tr(lang);
  if (s.titles?.[section]) return s.titles[section];
  switch (section) {
    case "booked": return T.outBooked;
    case "keen": return T.outInterested;
    case "seen": return T.outSeen;
    case "new": return T.batchNew(n);
    case "new_dates": return T.batchNewDates(n);
    case "last_weeks": return T.batchLastWeeks(n);
    case "theatre": return T.theatreSection.trim();
    case "expo": return T.expoSection.trim();
    case "film": return T.filmSection.trim();
    default: return "";
  }
}

function mark(r: Reaction | undefined, lang: Lang, full: boolean): string {
  if (!r) return "";
  if (r.status === "seen") {
    if (!full) return " · ✅";
    return ` · ✅${r.rating ? ` ${stars(r.rating)}` : ""}${r.comment ? ` · « ${esc(short(r.comment, 60))} »` : ""}`;
  }
  if (r.status === "ignored") return " · 🙅";
  if (r.booked_at) return ` · 🎟${full ? ` ${whenLabel(r.booked_at, lang)}` : ""}`;
  if (r.interested) return " · ⭐";
  return "";
}

/** Note de la presse / des critiques déjà présente dans la ligne de récap (« ★★★½ »). */
const rating = (it: Item) => (it.line ?? "").match(/[★☆½]{2,}/u)?.[0] ?? "";

/** Rend la vue liste (page s.p). */
export async function renderList(env: Env, chat: number, s: ListState, lang: Lang): Promise<{ text: string; kb: unknown; empty: boolean }> {
  const T = tr(lang);
  const all = await entriesFor(env, chat, s);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  s.p = Math.min(Math.max(0, s.p), pages - 1);
  const page = all.slice(s.p * PAGE_SIZE, (s.p + 1) * PAGE_SIZE);
  const ids = page.map((e) => e.id);
  const { results: items } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id WHERE i.id IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(ids)).all<Item & { venue: string }>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const { results: rs } = await env.DB.prepare(
    "SELECT * FROM reactions WHERE chat_id = ? AND item_id IN (SELECT value FROM json_each(?))",
  ).bind(chat, JSON.stringify(ids)).all<Reaction>();
  const react = new Map(rs.map((r) => [r.item_id, r]));

  const blocks: string[] = [];
  if (s.k === "prog") blocks.push(T.progHead(all.length));
  if (s.head) blocks.push(s.head);
  let cur = "";
  const lines: string[] = [];
  const flush = () => { if (lines.length) blocks.push(lines.splice(0).join("\n")); };
  for (const e of page) {
    const it = byId.get(e.id);
    if (!it) continue;
    if (e.section !== cur) {
      flush();
      cur = e.section;
      const t = sectionTitle(s, cur, all.filter((x) => x.section === cur).length, lang);
      if (t) lines.push(t);
    }
    const title = it.url ? `<a href="${esc(it.url)}">${esc(it.title)}</a>` : `<b>${esc(it.title)}</b>`;
    const r = rating(it);
    let line = `${ICON[it.kind] ?? "🎭"} ${title} — <i>${esc(it.venue)}</i>${r ? ` · ${r}` : ""}${mark(react.get(it.id), lang, true)}`;
    if (e.header) line += `\n   ${e.header}`;
    lines.push(line);
  }
  flush();
  const rows: unknown[][] = [];
  if (s.k === "prog") {
    rows.push([["all", T.filterAll], ["theatre", "🎭"], ["expo", "🖼"], ["film", "🎬"]].map(([f, label]) => ({
      text: (s.f ?? "all") === f ? `· ${label} ·` : label, callback_data: `lf:${f}`,
    })));
  }
  for (const e of page) {
    const it = byId.get(e.id);
    if (it) rows.push([{ text: `${ICON[it.kind] ?? "🎭"} ${short(it.title)}${mark(react.get(it.id), lang, false)}`, callback_data: `lo:${it.id}` }]);
  }
  if (pages > 1) {
    rows.push([
      { text: "◀", callback_data: s.p > 0 ? `lp:${s.p - 1}` : "ln" },
      { text: `${s.p + 1}/${pages}`, callback_data: "ln" },
      { text: "▶", callback_data: s.p < pages - 1 ? `lp:${s.p + 1}` : "ln" },
    ]);
  }
  return { text: blocks.join("\n\n") || T.listEmpty, kb: { inline_keyboard: rows }, empty: !all.length };
}

/** Envoie une nouvelle liste et mémorise son état. */
export async function sendList(env: Env, chat: number, s: ListState, lang: Lang, emptyText?: string): Promise<number | null> {
  const v = await renderList(env, chat, s, lang);
  if (v.empty && emptyText) { await send(env, chat, emptyText); return null; }
  const res = await send(env, chat, v.text, v.kb);
  const id = res?.result?.message_id ?? null;
  if (id) await saveList(env, chat, id, { ...s, open: null });
  return id;
}

/** Remet le message en vue liste (↩︎, pagination, filtre). */
export async function showList(env: Env, chat: number, msg: number, s: ListState, lang: Lang): Promise<void> {
  s.open = null;
  const v = await renderList(env, chat, s, lang);
  await saveList(env, chat, msg, s);
  await edit(env, chat, msg, v.text, v.kb);
}

/** Déplie un item : la fiche complète dans ce message, boutons d'état + [↩︎ Liste]. */
export async function openItem(env: Env, chat: number, msg: number, s: ListState, item: Item, lang: Lang): Promise<void> {
  s.open = item.id;
  await saveList(env, chat, msg, s);
  const r = await env.DB.prepare("SELECT * FROM reactions WHERE chat_id = ? AND item_id = ?").bind(chat, item.id).first<Reaction>();
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const header = (s.items ?? []).find((e) => e.id === item.id)?.header ?? null;
  if (s.k === "sunday") {
    // Film du récap : la fiche propre à SES cinémas (séances), gardée par le job ciné.
    const own = await env.DB.prepare("SELECT text FROM film_queue WHERE chat_id = ? AND item_id = ?")
      .bind(chat, item.id).first<{ text: string }>();
    if (own?.text) item = { ...item, text: own.text, text_en: own.text };
  }
  const v = renderFor(item, chat, r ?? null, friends, header, lang);
  await edit(env, chat, msg, v.text, withBackRow(v.reply_markup, lang));
}

export function withBackRow(markup: unknown, lang: Lang): unknown {
  const rows = ((markup as any)?.inline_keyboard ?? []) as unknown[][];
  return { inline_keyboard: [...rows, [{ text: tr(lang).btnList, callback_data: "lb" }]] };
}

/** Une fiche affichée DANS une liste garde son [↩︎ Liste] après chaque action. */
export async function cardMarkup(env: Env, chat: number, msg: number, markup: unknown, lang: Lang): Promise<unknown> {
  const s = await getList(env, chat, msg);
  return s?.open ? withBackRow(markup, lang) : markup;
}


