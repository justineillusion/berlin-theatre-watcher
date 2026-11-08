// Lot du matin (~9:00 Berlin) : au plus UN message par jour et par personne pour les
// nouveautés (pièces / expos nouvelles, nouvelles dates, dernières semaines d'une ⭐).
// Une ligne compacte par item + un bouton qui ouvre sa fiche complète (callback « oc: »).
// Le scan met en file (daily_queue) au lieu d'envoyer ; les ventes et « X a réservé » restent immédiats.
import { Lang, asLang, tr } from "./i18n";
import { Env, Item, Reaction, friendsByItem, itemLine, renderFor, send, setSetting, setting } from "./lib";
import { berlinNow } from "./sales";

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

/** Une passe du cron : à partir de 9:00 (Berlin), un lot par personne et par jour. */
export async function dailyTick(env: Env, now = new Date()): Promise<number> {
  const b = berlinNow(now);
  if (b.hm < "09:00") return 0;
  const { results: chats } = await env.DB.prepare(
    "SELECT DISTINCT q.chat_id FROM daily_queue q JOIN users u ON u.chat_id = q.chat_id AND u.active = 1 WHERE q.sent_at IS NULL LIMIT 60",
  ).all<{ chat_id: number }>();
  let n = 0;
  for (const { chat_id } of chats) {
    const key = `daily_sent:${chat_id}:${b.day}`;
    if (await setting(env, key)) continue;                 // déjà eu son lot aujourd'hui : demain
    const rows = await queued(env, chat_id);
    const lang = asLang(rows[0]?.lang ?? null);
    const msg = batchMessage(rows, lang);
    await setSetting(env, key, now.toISOString());          // avant l'envoi : jamais deux fois
    await env.DB.prepare("UPDATE daily_queue SET sent_at = datetime('now') WHERE chat_id = ? AND sent_at IS NULL").bind(chat_id).run();
    if (!msg) continue;
    const res = await send(env, chat_id, msg.text, msg.reply_markup);
    if (res?.error_code === 403) await env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?").bind(chat_id).run();
    n++;
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

