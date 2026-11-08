// Le groupe Telegram de la bande : /interets, /programme, /aide, annonces,
// « plan » quand 2+ personnes veulent voir la même chose, avis complets, récap hebdo.
// Tout est dans la langue du groupe (settings.group_lang, celle de qui a tapé /groupe).
import { Lang, asLang, tr } from "./i18n";
import { Env, Item, basicText, edit, esc, horizon, inWindow, itemText, send, setSetting, setting, stars, tg, windowSql, appLink } from "./lib";

const ICON: Record<string, string> = { theatre: "🎭", expo: "🖼", cinema: "🎬", film: "🎬" };
const today = () => new Date().toISOString().slice(0, 10);

export async function groupChat(env: Env): Promise<string | null> {
  return setting(env, "group_chat_id");
}

export async function groupLang(env: Env): Promise<Lang> {
  return asLang(await setting(env, "group_lang"));
}

/** '2026-11-18 20:00' -> 'Wed 18/11 20:00' (ou 'mer. 18/11 20:00'). */
function fmtWhen(iso: string, lang: Lang): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  const day = isNaN(d.getTime()) ? "" : tr(lang).days[d.getUTCDay()] + " ";
  return `${day}${iso.slice(8, 10)}/${iso.slice(5, 7)}${iso.length > 10 ? " " + iso.slice(11, 16) : ""}`;
}

const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

/** « 📍 Lieu · until 20/06/27 » ou « 📍 Lieu · Next dates: Wed 18/11 20:00, … ». */
export function whereWhen(item: Item, venue: string | null | undefined, lang: Lang, max = 3): string {
  const T = tr(lang);
  const parts = [venue ? `📍 ${esc(venue)}` : ""];
  if (item.kind === "expo") {
    if (item.end_date) parts.push(T.until(shortDate(item.end_date)));
  } else {
    const now = today();
    const all = (JSON.parse(item.dates || "[]") as string[]).filter((d) => d.slice(0, 10) >= now).sort();
    const next = item.kind === "theatre" ? inWindow(all) : all;
    if (next.length) {
      const more = next.length > max ? ` (+${next.length - max})` : "";
      parts.push(T.nextDates(next.slice(0, max).map((d) => fmtWhen(d, lang)).join(", ") + more));
    }
  }
  return parts.filter(Boolean).join(" · ");
}

const titleLink = (item: Item) =>
  `${ICON[item.kind] ?? "🎭"} ${item.url ? `<a href="${esc(item.url)}">${esc(item.title)}</a>` : `<b>${esc(item.title)}</b>`}`;

const joinNames = (names: string[], lang: Lang) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${tr(lang).and} ${names[names.length - 1]}`;

function chunks(head: string, blocks: string[], limit = 3500): string[] {
  const out: string[] = [];
  let cur = head;
  for (const b of blocks) {
    if (cur.length + b.length + 2 > limit) { out.push(cur); cur = b; } else cur += "\n\n" + b;
  }
  out.push(cur);
  return out;
}

/** Items encore à l'affiche qui tentent au moins un membre actif (sans « vu »/« ignoré »). */
async function wanted(env: Env) {
  const since = (await setting(env, "current_since")) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue, group_concat(u.first_name, '|') AS names, COUNT(*) AS n
     FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.interested = 1 AND r.status IS NULL
       AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= ?2
                 ELSE i.last_seen >= datetime(?1, '-2 days') END)
       AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= ?2)
       AND ${windowSql(await horizon(env))}
     GROUP BY i.id ORDER BY n DESC, i.title LIMIT 40`,
  ).bind(since, today()).all<Item & { venue: string; names: string; n: number }>();
  return results;
}

/** /interets dans le groupe, et le récap hebdo du groupe. */
export async function groupInterests(env: Env, lang: Lang, title?: string): Promise<string[]> {
  const T = tr(lang);
  const rows = await wanted(env);
  if (!rows.length) return [`${title ?? T.groupInterestsTitle}\n\n${T.groupNoInterests}`];
  const blocks = rows.map((r) =>
    `${titleLink(r)}\n${whereWhen(r, r.venue, lang)}\n⭐ ${esc(r.names.split("|").join(", "))}`);
  return chunks(title ?? T.groupInterestsTitle, blocks);
}

/** /programme dans le groupe : liste compacte + boutons ⭐ (union des lieux suivis par les membres). */
export async function groupProgramme(env: Env, lang: Lang): Promise<{ text: string; reply_markup?: unknown }[]> {
  const T = tr(lang);
  const since = (await setting(env, "current_since")) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE i.last_seen >= ?1
       AND EXISTS (SELECT 1 FROM subscriptions s JOIN users u ON u.chat_id = s.chat_id AND u.active = 1
                   WHERE s.venue_id = v.id)
       AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= ?2)
       AND ${windowSql(await horizon(env))}
     ORDER BY CASE i.kind WHEN 'theatre' THEN 0 ELSE 1 END, v.position, i.title LIMIT 60`,
  ).bind(since, today()).all<Item & { venue: string }>();
  if (!results.length) return [{ text: `${T.groupProgrammeTitle}\n\n${T.groupNothingOn}` }];

  // Par lieu : une ligne par item ; 1 message = au plus 20 items, avec leurs boutons ⭐.
  const out: { text: string; reply_markup?: unknown }[] = [];
  for (let i = 0; i < results.length; i += 20) {
    const part = results.slice(i, i + 20);
    const lines: string[] = [i === 0 ? `${T.groupProgrammeTitle}\n${T.groupProgrammeHint}` : ""];
    let venue = "";
    for (const it of part) {
      if (it.venue !== venue) { venue = it.venue; lines.push(`\n📍 <b>${esc(venue)}</b>`); }
      const when = whereWhen(it, null, lang, 2);
      lines.push(`${titleLink(it)}${when ? ` — <i>${when}</i>` : ""}`);
    }
    const buttons = part.map((it) => ({ text: T.pickButton(it.title.slice(0, 28)), callback_data: `i:${it.id}` }));
    const rows: unknown[][] = [];
    for (let j = 0; j < buttons.length; j += 2) rows.push(buttons.slice(j, j + 2));
    out.push({ text: lines.filter(Boolean).join("\n").trim(), reply_markup: { inline_keyboard: rows } });
  }
  return out;
}

/** Annonce du groupe = en-tête (qui, note, petit mot ENTIER) + la fiche commune de l'item. */
export function card(head: string, item: Item, lang: Lang): string {
  const body = itemText(item, lang) || basicText(item, lang);
  const room = 4000 - head.length - 2;
  return `${head}\n\n${body.length > room ? body.slice(0, room - 1) + "…" : body}`;
}

/** Boutons sous une annonce du groupe : ⭐ (moi aussi / je veux le voir) + ✅ je l'ai vu aussi. */
export const groupButtons = (env: Env, item: Item, lang: Lang, _review = false) => ({
  inline_keyboard: [[
    { text: tr(lang).meToo, callback_data: `i:${item.id}` },
    { text: tr(lang).sawToo, callback_data: `v:${item.id}` },
  ], [{ text: tr(lang).openApp, url: appLink(env, item.id) }]],
});

/** Message du groupe qui « porte » un item pour un membre (fil des réponses). */
export const threadKey = (chat: number, item: string) => `grp_thread:${chat}:${item}`;

/** Annonce d'intérêt : « ⭐ X est intéressé·e » ou « 🎟 Plan ! A & B… » dès 2 personnes.
 *  `editId` : on met à jour ce message du groupe au lieu d'en poster un nouveau. */
export async function announceInterest(
  env: Env, item: Item, venue: string | undefined, who: string, editId?: number,
): Promise<void> {
  const group = await groupChat(env);
  if (!group) return;
  const lang = await groupLang(env);
  const T = tr(lang);
  const { results } = await env.DB.prepare(
    `SELECT u.first_name FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     WHERE r.item_id = ? AND r.interested = 1 AND r.status IS NULL ORDER BY r.updated_at`,
  ).bind(item.id).all<{ first_name: string }>();
  const names = results.map((r) => esc(r.first_name));
  if (!names.length) names.push(esc(who));
  // Même fiche que partout (titre, lieu, dates, note, description, liens), précédée de qui est partant.
  const head = names.length >= 2 ? T.planHead(joinNames(names, lang)) : T.starHead(names[0]);
  const text = card(head, item, lang);
  if (editId) await edit(env, group, editId, text, groupButtons(env, item, lang));
  else await send(env, group, text, groupButtons(env, item, lang));
}

/** Avis complet dans le groupe : posté à la note (en réponse au message du groupe
 *  d'où vient le clic, s'il y en a un), puis MODIFIÉ quand le petit mot arrive. */
export async function announceReview(
  env: Env, item: Item, venue: string | undefined, chat: number, who: string, rating: number | null, comment: string | null,
): Promise<void> {
  const group = await groupChat(env);
  if (!group) return;
  const lang = await groupLang(env);
  const T = tr(lang);
  const head = [T.annSaw(esc(who))];
  if (rating) head.push(`${stars(rating)} ${rating}/5`);
  if (comment) head.push(`💬 “${esc(comment)}”`);
  const text = card(head.join("\n"), item, lang);
  const markup = groupButtons(env, item, lang, true);
  const key = `grp_review:${chat}:${item.id}`;
  const prev = await setting(env, key);
  if (prev) {
    const res = await edit(env, group, Number(prev), text, markup);
    if (res?.ok || String(res?.description || "").includes("not modified")) return;
  }
  const reply = await setting(env, threadKey(chat, item.id));
  const sent = await tg(env, "sendMessage", {
    chat_id: group, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup,
    ...(reply ? { reply_parameters: { message_id: Number(reply), allow_sending_without_reply: true } } : {}),
  });
  const id = sent?.result?.message_id;
  if (id) await setSetting(env, key, String(id));
}
