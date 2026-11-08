// Lot du matin (~9:00 Berlin) : au plus UN message par jour et par personne pour les
// nouveautés (pièces / expos nouvelles, nouvelles dates, dernières semaines d'une ⭐).
// Une ligne compacte par item + un bouton qui ouvre sa fiche complète (callback « oc: »).
// Le scan met en file (daily_queue) au lieu d'envoyer ; les ventes et « X a réservé » restent immédiats.
import { Lang, asLang, tr } from "./i18n";
import { Env, Item, Reaction, esc, friendsByItem, itemLine, renderFor, send, setSetting, setting, whenLabel } from "./lib";
import { berlinNow } from "./sales";
import { sundayOf } from "./scan";

const ICON: Record<string, string> = { theatre: "🎭", expo: "🖼", film: "🎬" };
const short = (t: string) => (t.length > 34 ? t.slice(0, 33) + "…" : t);
const MAX_ITEMS = 25;

interface Row extends Item { kind_q: string; header: string | null; lang: string | null; chat_id: number }

/** File du lot pour une personne (filtrée : vu / ignoré, ⭐ sauf « dernières semaines »). */
async function queued(env: Env, chat: number): Promise<Row[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.*, q.kind AS kind_q, q.header, q.chat_id, u.lang FROM daily_queue q
     JOIN items i ON i.id = q.item_id JOIN users u ON u.chat_id = q.chat_id AND u.active = 1
     LEFT JOIN reactions r ON r.chat_id = q.chat_id AND r.item_id = q.item_id
     WHERE q.chat_id = ? AND q.sent_at IS NULL AND r.status IS NULL
       AND (CASE WHEN q.kind = 'last_weeks' THEN COALESCE(r.interested, 0) = 1 ELSE COALESCE(r.interested, 0) = 0 END)
     ORDER BY i.starred DESC, CASE i.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END,
       COALESCE(NULLIF(i.start_date, ''), json_extract(i.dates, '$[0]'), '9999')`,
  ).bind(chat).all<Row>();
  return results;
}

/** Texte + boutons du lot ; null si rien (zéro remplissage : sections vides omises). */
export function batchMessage(rows: Row[], lang: Lang): { text: string; reply_markup: unknown } | null {
  if (!rows.length) return null;
  const T = tr(lang);
  const shown = rows.slice(0, MAX_ITEMS);
  const blocks: string[] = [];
  for (const [kind, title] of [["new", T.batchNew], ["new_dates", T.batchNewDates], ["last_weeks", T.batchLastWeeks]] as const) {
    const part = shown.filter((r) => r.kind_q === kind);
    if (!part.length) continue;
    const lines = part.map((r) => {
      const line = itemLine(r, lang);
      return kind === "new" || !r.header ? line : `${line}\n   ${r.header}`;
    });
    blocks.push(`${title(part.length)}\n${lines.join("\n")}`);
  }
  let text = blocks.join("\n\n");
  if (rows.length > shown.length) text += `\n\n${T.batchMore(rows.length - shown.length)}`;
  if (text.length > 3900) text = text.slice(0, 3899) + "…";
  return {
    text,
    reply_markup: { inline_keyboard: shown.map((r) => [{ text: `${ICON[r.kind] ?? "🎭"} ${short(r.title)}`, callback_data: `oc:${r.id}` }]) },
  };
}

const addDays = (day: string, n: number) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** Dimanche : mes 🎟 d'ici dimanche prochain, et les expos qui ouvrent dans les 7 jours (lieux suivis). */
async function sundaySections(env: Env, chat: number, day: string, lang: Lang, skip: Set<string>): Promise<string[]> {
  const T = tr(lang);
  const end = addDays(day, 7);
  const { results: booked } = await env.DB.prepare(
    `SELECT i.title, i.url, i.kind, r.booked_at, v.name AS venue FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status IS NULL AND r.booked_at IS NOT NULL
       AND substr(r.booked_at, 1, 10) BETWEEN ? AND ? ORDER BY r.booked_at LIMIT 20`,
  ).bind(chat, day, end).all<{ title: string; url: string | null; kind: string; booked_at: string; venue: string }>();
  const { results: expos } = await env.DB.prepare(
    `SELECT i.* FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     JOIN subscriptions s ON s.venue_id = i.venue_id AND s.chat_id = ?1
     LEFT JOIN reactions r ON r.item_id = i.id AND r.chat_id = ?1
     WHERE i.kind = 'expo' AND r.status IS NULL AND i.start_date > ?2 AND i.start_date <= ?3
     ORDER BY i.start_date, v.position LIMIT 20`,
  ).bind(chat, day, end).all<Item>();
  const out: string[] = [];
  if (booked.length) {
    out.push(`${T.sunBooked}\n` + booked.map((b) => {
      const t = b.url ? `<a href="${esc(b.url)}">${esc(b.title)}</a>` : `<b>${esc(b.title)}</b>`;
      return `${ICON[b.kind] ?? "🎭"} ${t} — ${whenLabel(b.booked_at, lang)} <i>(${esc(b.venue)})</i>`;
    }).join("\n"));
  }
  const opening = expos.filter((e) => !skip.has(e.id));            // déjà dans « Nouveau » : pas deux fois
  if (opening.length) out.push(`${T.sunExpos}\n` + opening.map((e) => itemLine(e, lang)).join("\n"));
  return out;
}

/** Une passe du cron : à partir de 9:00 (Berlin), un envoi par personne et par jour. Le dimanche,
 *  c'est le récap : en-tête (mes 🎟, expos qui ouvrent, nouveautés, ciné) puis les fiches films. */
export async function dailyTick(env: Env, now = new Date()): Promise<number> {
  const b = berlinNow(now);
  if (b.hm < "09:00") return 0;
  const sunday = sundayOf(now) === b.day;
  // Dimanche : on attend les films du job ciné (GitHub, parfois en retard) jusqu'à midi.
  if (sunday && b.hm < "12:00" && (await setting(env, "film_plan_day")) !== b.day) return 0;
  if (sunday && b.hm >= "15:00") return 0;                  // trop tard pour un récap du matin : lundi
  const { results: chats } = await env.DB.prepare(sunday
    ? "SELECT chat_id FROM users WHERE active = 1 LIMIT 60"
    : "SELECT DISTINCT q.chat_id FROM daily_queue q JOIN users u ON u.chat_id = q.chat_id AND u.active = 1 WHERE q.sent_at IS NULL LIMIT 60",
  ).all<{ chat_id: number }>();
  let n = 0;
  for (const { chat_id } of chats) {
    const key = `daily_sent:${chat_id}:${b.day}`;
    if (await setting(env, key)) continue;                 // déjà eu son envoi aujourd'hui : demain
    const user = await env.DB.prepare("SELECT lang FROM users WHERE chat_id = ?").bind(chat_id).first<{ lang: string | null }>();
    const lang = asLang(user?.lang ?? null);
    const rows = await queued(env, chat_id);
    const batch = batchMessage(rows, lang);
    let text = batch?.text ?? "";
    let films: { item_id: string; kind: string; header: string | null; dates: string; text: string; markup: string | null }[] = [];
    if (sunday) {
      films = (await env.DB.prepare(
        `SELECT item_id, kind, header, dates, text, markup FROM film_queue
         WHERE chat_id = ? AND sent_at IS NULL AND queued_at >= datetime('now', '-1 day') ORDER BY queued_at, rowid`,
      ).bind(chat_id).all<any>()).results;
      const filmHead = films.length ? await setting(env, `film_header:${chat_id}`) : null;
      const skip = new Set(rows.slice(0, 25).map((r) => r.id));
      text = [...await sundaySections(env, chat_id, b.day, lang, skip), text, filmHead ?? ""].filter(Boolean).join("\n\n");
    }
    await setSetting(env, key, now.toISOString());          // avant l'envoi : jamais deux fois
    await env.DB.batch([
      env.DB.prepare("UPDATE daily_queue SET sent_at = datetime('now') WHERE chat_id = ? AND sent_at IS NULL").bind(chat_id),
      env.DB.prepare("UPDATE film_queue SET sent_at = datetime('now') WHERE chat_id = ? AND sent_at IS NULL").bind(chat_id),
    ]);
    if (!text) continue;                                     // rien : rien du tout
    const res = await send(env, chat_id, text.length > 4000 ? text.slice(0, 3999) + "…" : text, batch?.reply_markup);
    if (res?.error_code === 403) {
      await env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?").bind(chat_id).run();
      continue;
    }
    n++;
    for (const f of films) {
      const r = await send(env, chat_id, f.text, f.markup ? JSON.parse(f.markup) : undefined);
      const id = r?.result?.message_id;
      if (!id) continue;
      await env.DB.prepare(
        `INSERT INTO deliveries (chat_id, item_id, dates, message_id, header, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(chat_id, item_id) DO UPDATE SET
           dates = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(deliveries.dates) UNION SELECT value FROM json_each(?3))),
           message_id = ?4, header = ?5, sent_at = datetime('now')`,
      ).bind(chat_id, f.item_id, f.dates, id, f.header).run();
    }
  }
  return n;
}

/** Bouton d'une ligne du lot : envoie la fiche complète (elle devient « ma notif » : mises à jour, ✏️…). */
export async function openCard(env: Env, chat: number, item: Item, lang: Lang): Promise<void> {
  const q = await env.DB.prepare("SELECT header FROM daily_queue WHERE chat_id = ? AND item_id = ?")
    .bind(chat, item.id).first<{ header: string | null }>();
  const r = await env.DB.prepare("SELECT * FROM reactions WHERE chat_id = ? AND item_id = ?").bind(chat, item.id).first<Reaction>();
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const v = renderFor(item, chat, r ?? null, friends, q?.header ?? null, lang);
  const res = await send(env, chat, v.text, v.reply_markup);
  const id = res?.result?.message_id;
  if (!id) return;
  await env.DB.prepare(
    `INSERT INTO deliveries (chat_id, item_id, dates, message_id, header) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, item_id) DO UPDATE SET message_id = excluded.message_id, header = excluded.header`,
  ).bind(chat, item.id, item.dates || "[]", id, q?.header ?? null).run();
}

