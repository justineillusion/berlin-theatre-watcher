// Webhook Telegram : commandes, boutons ⭐ / ✅ / 🔕, notes, petits mots.
import {
  Env, Friend, Horizon, Item, Reaction, edit, esc, friendsByItem, getItem, getReaction, horizon, keyboard, renderFor,
  send, setSetting, setting, socialBlock, stars, tg, windowSql,
} from "./lib";
import { digestFor } from "./scan";
import { Lang, asLang, guessLang, langKeyboard, setChatMenu, tr } from "./i18n";
import {
  announceInterest, announceReview, groupChat, groupInterests, groupLang as grpLang, groupProgramme, threadKey,
} from "./group";

interface TgUser { id: number; first_name: string; username?: string; language_code?: string }

const help = (env: Env, chat: number, lang: Lang) => tr(lang).help + (isOwner(env, chat) ? tr(lang).ownerHelp : "");



const isOwner = (env: Env, id: number) => String(id) === String(env.OWNER_CHAT_ID);

async function getUser(env: Env, chat_id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chat_id)
    .first<{ chat_id: number; first_name: string; active: number; pending_item: string | null; lang: string | null }>();
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 12);
}

export async function inviteCode(env: Env): Promise<string> {
  let code = await setting(env, "invite_code");
  if (!code) { code = randomCode(); await setSetting(env, "invite_code", code); }
  return code;
}

// ---------------------------------------------------------------------------
export async function handleUpdate(env: Env, update: any, ctx: ExecutionContext): Promise<void> {
  if (update.callback_query) return onCallback(env, update.callback_query, ctx);
  const msg = update.message;
  if (!msg?.from || !msg.text) return;

  const from: TgUser = msg.from;
  const text: string = msg.text.trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.startsWith("/") ? rawCmd.split("@")[0].toLowerCase() : "";

  if (msg.chat.type !== "private") {
    // /groupe (admin) enregistre le groupe ; ensuite, dans CE groupe seulement :
    // /interets, /programme, /aide (les « /cmd@bot » sont déjà ramenés à « /cmd »).
    if (cmd === "/groupe" && isOwner(env, from.id)) {
      const owner = await getUser(env, from.id);
      const lang = owner ? asLang(owner.lang) : guessLang(from.language_code);
      await setSetting(env, "group_chat_id", String(msg.chat.id));
      await setSetting(env, "group_lang", lang);
      await send(env, msg.chat.id, tr(lang).groupOn);
      return;
    }
    if (String(msg.chat.id) !== (await groupChat(env))) return;
    const G = tr(await grpLang(env));
    const lang = await grpLang(env);
    if (cmd === "/interets" || cmd === "/interests") {
      for (const m of await groupInterests(env, lang)) await send(env, msg.chat.id, m);
    } else if (cmd === "/programme" || cmd === "/program") {
      for (const m of await groupProgramme(env, lang)) await send(env, msg.chat.id, m.text, m.reply_markup);
    } else if (cmd === "/aide" || cmd === "/help" || cmd === "/start") {
      await send(env, msg.chat.id, G.groupHelp);
    }
    return;
  }

  const chat = from.id;
  const user = await getUser(env, chat);

  if (cmd === "/start") return onStart(env, from, user, args[0]);
  if (!user || !user.active) {
    const T = tr(user ? user.lang : guessLang(from.language_code));
    await send(env, chat, user ? T.unsubscribed : T.privateBot);
    return;
  }
  const lang = asLang(user.lang);
  const T = tr(lang);

  switch (cmd) {
    case "/suivre": return void (await send(env, chat, T.followPrompt, await followKeyboard(env, chat, lang)));
    case "/programme": case "/program": {
      const m = await programmeMenu(env, chat, lang);
      return void (await send(env, chat, m.text, m.kb));
    }
    case "/expos": case "/theatre": case "/theatres": case "/theater": case "/films": {
      const kind = cmd === "/expos" ? "expo" : cmd === "/films" ? "film" : "theatre";
      const m = await programmeMenu(env, chat, lang, kind);
      return void (await send(env, chat, m.text, m.kb));
    }
    case "/interets": return void (await send(env, chat, await interestsText(env, chat, lang)));
    case "/vus": return void (await send(env, chat, await seenText(env, chat, lang)));
    case "/ignores": return onIgnored(env, chat, lang);
    case "/langue": case "/language": case "/lang":
      return void (await send(env, chat, T.langPrompt, langKeyboard()));
    case "/stop":
      await env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?").bind(chat).run();
      return void (await send(env, chat, T.stopped));
    case "/passer": case "/skip":
      // Ferme l'invitation la plus récente (les autres restent ouvertes).
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE review_prompts SET closed = 1 WHERE rowid = (SELECT rowid FROM review_prompts
             WHERE chat_id = ? AND closed = 0 ORDER BY created_at DESC, message_id DESC LIMIT 1)`).bind(chat),
        env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat),
      ]);
      return void (await send(env, chat, "👌"));
    case "/aide": case "/help":
      return void (await send(env, chat, help(env, chat, lang)));
  }

  if (isOwner(env, chat)) {
    if (cmd === "/invite") return void (await send(env, chat, await inviteText(env, lang)));
    if (cmd === "/nouveaulien") {
      await setSetting(env, "invite_code", randomCode());
      return void (await send(env, chat, T.newLinkDone + await inviteText(env, lang)));
    }
    if (cmd === "/membres") return void (await send(env, chat, await membersText(env, lang)));
    if (cmd === "/plusdegroupe") {
      await setSetting(env, "group_chat_id", null);
      return void (await send(env, chat, T.groupOff));
    }
  }

  if (!cmd) {
    // Avis : la réponse à une invitation va à SON item ; un texte libre va à
    // l'invitation ouverte la plus récente (plusieurs peuvent être ouvertes).
    const replyTo = msg.reply_to_message?.message_id;
    const prompt = replyTo
      ? await env.DB.prepare("SELECT item_id FROM review_prompts WHERE chat_id = ? AND message_id = ?")
        .bind(chat, replyTo).first<{ item_id: string }>()
      : null;
    const latest = prompt ?? await env.DB.prepare(
      `SELECT item_id FROM review_prompts WHERE chat_id = ? AND closed = 0
       ORDER BY created_at DESC, message_id DESC LIMIT 1`).bind(chat).first<{ item_id: string }>();
    const itemId = latest?.item_id ?? user.pending_item;
    if (itemId) return onComment(env, chat, user.first_name, itemId, text, ctx, lang);
  }
  await send(env, chat, T.notUnderstood);
}

// ---------------------------------------------------------------------------
async function onStart(env: Env, from: TgUser, user: any, code?: string): Promise<void> {
  const chat = from.id;
  if (user) {
    const lang = asLang(user.lang);
    if (!user.active) await env.DB.prepare("UPDATE users SET active = 1 WHERE chat_id = ?").bind(chat).run();
    await send(env, chat, tr(lang).welcomeBack(esc(from.first_name)) + help(env, chat, lang));
    return;
  }
  const valid = isOwner(env, chat) || (code && code === await setting(env, "invite_code"));
  if (!valid) {
    await send(env, chat, tr(guessLang(from.language_code)).badInvite);
    return;
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (chat_id, first_name, username) VALUES (?, ?, ?)")
      .bind(chat, from.first_name, from.username ?? null),
    // Par défaut : tout. Le premier scan enregistre le catalogue en silence.
    env.DB.prepare("INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed) SELECT ?, id, 0 FROM venues WHERE active = 1")
      .bind(chat),
  ]);
  // Langue par défaut : français (users.lang). Le choix est proposé tout de suite.
  await setChatMenu(env, chat, "fr");
  const T = tr("fr");
  await send(env, chat, T.welcome(esc(from.first_name)) + help(env, chat, "fr") + "\n\n" + T.noSpam);
  await send(env, chat, T.defaultAll, await followKeyboard(env, chat, "fr"));
  await send(env, chat, T.langPrompt, langKeyboard(true));
  if (!isOwner(env, chat) && env.OWNER_CHAT_ID) {
    const owner = await getUser(env, Number(env.OWNER_CHAT_ID));
    await send(env, env.OWNER_CHAT_ID,
      tr(owner?.lang).joined(`${esc(from.first_name)}${from.username ? ` (@${esc(from.username)})` : ""}`));
  }
}

async function inviteText(env: Env, lang: Lang): Promise<string> {
  return tr(lang).invite(`https://t.me/${env.BOT_USERNAME}?start=${await inviteCode(env)}`);
}

async function membersText(env: Env, lang: Lang): Promise<string> {
  const T = tr(lang);
  const { results } = await env.DB.prepare(
    `SELECT u.first_name, u.username, u.active, u.lang,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id) AS subs,
       (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.interested = 1) AS stars
     FROM users u ORDER BY u.joined_at`,
  ).all<any>();
  const group = await setting(env, "group_chat_id");
  return T.members(results.filter((r) => r.active).length) +
    results.map((r) => `${r.active ? "•" : "✖️"} ${esc(r.first_name)}${r.username ? ` @${esc(r.username)}` : ""}` +
      ` ${r.lang === "en" ? "🇬🇧" : "🇫🇷"} — ${T.memberLine(r.subs, r.stars)}`).join("\n") +
    T.groupStatus(!!group);
}

// ---------------------------------------------------------------------------
// /suivre
// ---------------------------------------------------------------------------
const KIND_ICON: Record<string, string> = { theatre: "🎭", expo: "🖼", cinema: "🎬", film: "🎬" };

async function followKeyboard(env: Env, chat: number, lang: Lang): Promise<unknown> {
  const T = tr(lang);
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind, (s.chat_id IS NOT NULL) AS on_ FROM venues v
     LEFT JOIN subscriptions s ON s.venue_id = v.id AND s.chat_id = ?
     WHERE v.active = 1
     ORDER BY CASE v.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position`,
  ).bind(chat).all<{ id: string; name: string; kind: string; on_: number }>();
  if (!results.length) {
    return { inline_keyboard: [[{ text: T.noVenues, callback_data: "sd" }]] };
  }
  const rows = results.map((v) => [{
    text: `${v.on_ ? "✅" : "⬜️"} ${KIND_ICON[v.kind] ?? "🎭"} ${v.name}`,
    callback_data: `s:${v.id}`,
  }]);
  rows.push([
    { text: T.all, callback_data: "sa" },
    { text: T.none, callback_data: "sn" },
    { text: T.done, callback_data: "sd" },
  ]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------
async function interestsText(env: Env, chat: number, lang: Lang): Promise<string> {
  const T = tr(lang);
  const since = (await setting(env, "current_since")) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.url, v.name AS venue, COUNT(*) AS n,
       MAX(r.chat_id = ?1) AS mine
     FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.interested = 1 AND r.status IS NULL
       AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                 ELSE i.last_seen >= datetime(?2, '-2 days') END)
       AND ${windowSql(await horizon(env))}
     GROUP BY i.id ORDER BY n DESC, i.title LIMIT 30`,
  ).bind(chat, since).all<any>();
  if (!results.length) return T.noInterests;
  const friends = await friendsByItem(env, results.map((r) => r.id));
  const lines = results.map((r) => {
    const t = r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title);
    const who = (friends.get(r.id) ?? []).filter((f) => f.interested && !f.status)
      .map((f) => (f.chat_id === chat ? T.youBold : esc(f.first_name))).join(", ");
    return `${KIND_ICON[r.kind] ?? "🎭"} ${t} <i>(${esc(r.venue)})</i>\n   ⭐ ${who}`;
  });
  return `${T.interestsTitle}\n\n${lines.join("\n")}`;
}

async function seenText(env: Env, chat: number, lang: Lang): Promise<string> {
  const T = tr(lang);
  const { results } = await env.DB.prepare(
    `SELECT i.title, i.kind, r.rating, r.comment, v.name AS venue FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status = 'seen' ORDER BY r.updated_at DESC LIMIT 40`,
  ).bind(chat).all<any>();
  if (!results.length) return T.noneSeen;
  return `${T.seenTitle}\n\n` + results.map((r) =>
    `${r.kind === "expo" ? "🖼" : "🎭"} ${esc(r.title)} <i>(${esc(r.venue)})</i>${r.rating ? ` ${stars(r.rating)}` : ""}` +
    (r.comment ? `\n   « ${esc(r.comment)} »` : "")).join("\n");
}

async function onIgnored(env: Env, chat: number, lang: Lang): Promise<void> {
  const T = tr(lang);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.title, v.name AS venue FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status = 'ignored' ORDER BY r.updated_at DESC LIMIT 20`,
  ).bind(chat).all<any>();
  if (!results.length) return void (await send(env, chat, T.noneIgnored));
  await send(env, chat, T.ignoredTitle, {
    inline_keyboard: results.map((r) => [{ text: `↩️ ${r.title} (${r.venue})`.slice(0, 60), callback_data: `u:${r.id}` }]),
  });
}

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------
async function setReaction(env: Env, chat: number, item: string, patch: Partial<Reaction>): Promise<Reaction> {
  const cur = (await getReaction(env, chat, item)) ??
    { chat_id: chat, item_id: item, interested: 0, status: null, rating: null, comment: null };
  const next = { ...cur, ...patch };
  await env.DB.prepare(
    `INSERT INTO reactions (chat_id, item_id, interested, status, rating, comment, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id, item_id) DO UPDATE SET interested = excluded.interested, status = excluded.status,
       rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at`,
  ).bind(chat, item, next.interested, next.status, next.rating, next.comment).run();
  return next;
}

/** Re-rend la notif de chaque destinataire (liste ⭐, avis) — max 40 éditions. */
async function refreshAll(env: Env, item: Item, except: number | null): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT d.chat_id, d.message_id, d.header, u.lang FROM deliveries d JOIN users u ON u.chat_id = d.chat_id
     WHERE d.item_id = ? AND d.message_id IS NOT NULL AND u.active = 1 ORDER BY d.sent_at DESC LIMIT 40`,
  ).bind(item.id).all<{ chat_id: number; message_id: number; header: string | null; lang: string | null }>();
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const reactions = new Map(friends.map((f) => [f.chat_id, f as Reaction]));
  const { results: others } = await env.DB.prepare("SELECT * FROM reactions WHERE item_id = ?").bind(item.id).all<Reaction>();
  for (const r of others) reactions.set(r.chat_id, r);
  for (const d of results) {
    if (d.chat_id === except) continue;
    const view = renderFor(item, d.chat_id, reactions.get(d.chat_id) ?? null, friends, d.header, asLang(d.lang));
    await edit(env, d.chat_id, d.message_id, view.text, view.reply_markup);
  }
}

async function myDelivery(env: Env, chat: number, item: string) {
  return env.DB.prepare("SELECT message_id, header FROM deliveries WHERE chat_id = ? AND item_id = ?")
    .bind(chat, item).first<{ message_id: number | null; header: string | null }>();
}

/** Annonce au groupe, dans la langue du groupe (`make` reçoit le dictionnaire). */
// ---------------------------------------------------------------------------
// /programme : menu court (catégories + lieux suivis, avec comptes), puis les
// fiches complètes du choix, 5 par 5 (« Plus ▸ »), chacune avec ⭐ ✅ 🔕.
// ---------------------------------------------------------------------------
const PAGE = 5;

/** Items « à l'affiche » vus par `chat` : lieux suivis, encore programmés, pas ignorés. */
/** `keepStarred` : « Nos envies » montre justement les ⭐ ; ailleurs, ce que
 *  la personne a déjà vu, ignoré ou marqué ⭐ n'est plus reproposé. */
const current = (h: Horizon, keepStarred = false) => `
  ${windowSql(h)} AND
  i.venue_id IN (SELECT venue_id FROM subscriptions WHERE chat_id = ?1)
  AND (CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
            ELSE i.last_seen >= ?2 END)
  AND (i.kind != 'expo' OR i.end_date IS NULL OR i.end_date = '' OR i.end_date >= date('now'))
  AND NOT EXISTS (SELECT 1 FROM reactions x WHERE x.item_id = i.id AND x.chat_id = ?1
                  AND (x.status IS NOT NULL ${keepStarred ? "" : "OR x.interested = 1"}))`;

async function programmeMenu(env: Env, chat: number, lang: Lang, kind: string | null = null): Promise<{ text: string; kb: unknown }> {
  const T = tr(lang);
  const cur = current(await horizon(env));
  const since = (await setting(env, "current_since")) ?? "";
  const { results: venues } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind AS vkind, COUNT(*) AS n FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE ${cur} AND (?3 IS NULL OR i.kind = ?3)
     GROUP BY v.id ORDER BY CASE v.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position`,
  ).bind(chat, since, kind).all<{ id: string; name: string; vkind: string; n: number }>();
  const { results: kinds } = await env.DB.prepare(
    `SELECT i.kind, COUNT(*) AS n FROM items i WHERE ${cur} GROUP BY i.kind`,
  ).bind(chat, since).all<{ kind: string; n: number }>();
  const star = await env.DB.prepare(
    `SELECT COUNT(DISTINCT r.item_id) AS n FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     JOIN items i ON i.id = r.item_id WHERE r.interested = 1 AND r.status IS NULL AND ${current(await horizon(env), true)}`,
  ).bind(chat, since).first<{ n: number }>();
  const count = (k: string) => kinds.find((x) => x.kind === k)?.n ?? 0;
  const rows: unknown[][] = [];
  if (!kind) {
    const cats = [
      { k: "theatre", t: T.catTheatre, n: count("theatre") },
      { k: "expo", t: T.catExpo, n: count("expo") },
      { k: "film", t: T.catFilm, n: count("film") },
      { k: "star", t: T.catStar, n: star?.n ?? 0 },
    ].filter((c) => c.n > 0).map((c) => ({ text: `${c.t} (${c.n})`, callback_data: `pk:${c.k}:0` }));
    for (let j = 0; j < cats.length; j += 2) rows.push(cats.slice(j, j + 2));
  }
  for (const v of venues) rows.push([{ text: `${KIND_ICON[v.vkind] ?? "🎭"} ${v.name} (${v.n})`, callback_data: `pv:${v.id}:0` }]);
  if (!rows.length) return { text: T.noFollowed, kb: { inline_keyboard: [] } };
  return { text: T.browsePrompt, kb: { inline_keyboard: rows } };
}

/** Une page de fiches : `filter` = « pk:<theatre|expo|film|star> » ou « pv:<lieu> ». */
async function browse(env: Env, chat: number, lang: Lang, filter: string, offset: number): Promise<void> {
  const T = tr(lang);
  const [type, value] = [filter.slice(0, 2), filter.slice(3)];
  const cur = current(await horizon(env), value === "star");
  const since = (await setting(env, "current_since")) ?? "";
  const where = type === "pv" ? "i.venue_id = ?3"
    : value === "star"
      ? `EXISTS (SELECT 1 FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
                 WHERE r.item_id = i.id AND r.interested = 1 AND r.status IS NULL) AND ?3 = ?3`
      : "i.kind = ?3";
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE ${cur} AND ${where}
     ORDER BY CASE i.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position,
       COALESCE(NULLIF(i.start_date, ''), json_extract(i.dates, '$[0]'), '9999'), i.title
     LIMIT ?4 OFFSET ?5`,
  ).bind(chat, since, value, PAGE + 1, offset).all<Item>();
  if (!results.length) return void (await send(env, chat, T.browseEmpty));
  const shown = results.slice(0, PAGE);
  const friends = await friendsByItem(env, shown.map((i) => i.id));
  const { results: mine } = await env.DB.prepare(
    "SELECT * FROM reactions WHERE chat_id = ? AND item_id IN (SELECT value FROM json_each(?))",
  ).bind(chat, JSON.stringify(shown.map((i) => i.id))).all<Reaction>();
  const react = new Map(mine.map((r) => [r.item_id, r]));
  for (const it of shown) {
    const v = renderFor(it, chat, react.get(it.id) ?? null, friends.get(it.id) ?? [], null, lang);
    await send(env, chat, v.text, v.reply_markup);
  }
  if (results.length > PAGE) {
    await send(env, chat, T.more, { inline_keyboard: [[{ text: T.moreButton, callback_data: `${filter}:${offset + PAGE}` }]] });
  }
}

function label(item: Item, venueName?: string): string {
  const t = item.url ? `<a href="${esc(item.url)}">${esc(item.title)}</a>` : `<b>${esc(item.title)}</b>`;
  return `${KIND_ICON[item.kind] ?? "🎭"} ${t}${venueName ? ` (${esc(venueName)})` : ""}`;
}

async function onCallback(env: Env, cq: any, ctx: ExecutionContext): Promise<void> {
  const from: TgUser = cq.from;
  const chat = from.id;
  const data: string = cq.data ?? "";
  const answer = (text?: string, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });

  const user = await getUser(env, chat);
  if (!user?.active) {
    // Dans le groupe : on ouvre directement le bot avec le lien d'invitation.
    if (cq.message?.chat?.type !== "private") {
      return void (await tg(env, "answerCallbackQuery", {
        callback_query_id: cq.id, url: `https://t.me/${env.BOT_USERNAME}?start=${await inviteCode(env)}`,
      }));
    }
    return void (await answer(tr(guessLang(from.language_code)).openFirst(env.BOT_USERNAME), true));
  }
  let lang = asLang(user.lang);
  let T = tr(lang);

  // --- /langue -------------------------------------------------------------
  if (data.startsWith("l:")) {
    const [, code, onboarding] = data.split(":");
    lang = asLang(code);
    T = tr(lang);
    await env.DB.prepare("UPDATE users SET lang = ? WHERE chat_id = ?").bind(lang, chat).run();
    await setChatMenu(env, chat, lang);
    await edit(env, cq.message.chat.id, cq.message.message_id, T.langSet);
    await answer();
    // Inscription : l'accueil est parti en français ; on le redonne dans la langue choisie.
    if (onboarding && lang !== "fr") {
      await send(env, chat, T.welcome(esc(from.first_name)) + help(env, chat, lang) + "\n\n" + T.noSpam);
      await send(env, chat, T.defaultAll, await followKeyboard(env, chat, lang));
    }
    return;
  }

  // --- parcourir un lieu ---------------------------------------------------
  if (data.startsWith("pv:") || data.startsWith("pk:")) {
    await answer();
    const cut = data.lastIndexOf(":");
    const hasOffset = cut > 2 && /^\d+$/.test(data.slice(cut + 1));
    return browse(env, chat, lang, hasOffset ? data.slice(0, cut) : data, hasOffset ? Number(data.slice(cut + 1)) : 0);
  }

  // --- /suivre -----------------------------------------------------------
  if (data === "sd") {
    await edit(env, cq.message.chat.id, cq.message.message_id, T.saved);
    return void (await answer());
  }
  if (data === "sa" || data === "sn" || data.startsWith("s:")) {
    if (data === "sa") {
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed) SELECT ?, id, 0 FROM venues WHERE active = 1").bind(chat).run();
    } else if (data === "sn") {
      await env.DB.prepare("DELETE FROM subscriptions WHERE chat_id = ?").bind(chat).run();
    } else {
      const venue = data.slice(2);
      const del = await env.DB.prepare("DELETE FROM subscriptions WHERE chat_id = ? AND venue_id = ?").bind(chat, venue).run();
      if (!del.meta.changes) {
        await env.DB.prepare("INSERT INTO subscriptions (chat_id, venue_id, primed) VALUES (?, ?, 0)").bind(chat, venue).run();
      }
    }
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: await followKeyboard(env, chat, lang),
    });
    return void (await answer());
  }

  // --- réactions sur une pièce/expo ----------------------------------------
  const [op, itemId, arg] = data.split(":");
  const item = itemId ? await getItem(env, itemId) : null;
  if (!item) return void (await answer(T.gone));
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  const prev = await getReaction(env, chat, item.id);
  const inGroup = cq.message?.chat?.type !== "private";
  let r: Reaction;
  let toast = "";
  let socialChanged = true;

  switch (op) {
    case "i": {
      const on = inGroup ? 1 : prev?.interested ? 0 : 1;   // dans le groupe : « Moi aussi » ne décoche pas
      r = await setReaction(env, chat, item.id, { interested: on });
      toast = on ? T.toastStar : T.toastUnstar;
      if (on && !prev?.interested) {
        // Clic sur une annonce d'intérêt du groupe : on la met à jour (→ « 🎟 Plan ! ») ;
        // ailleurs (avis, liste /programme, notif privée) : nouvelle annonce.
        const clickedText = String(cq.message?.text ?? "");
        const editId = inGroup && /^(⭐|🎟)/u.test(clickedText) ? cq.message.message_id : undefined;
        ctx.waitUntil(announceInterest(env, item, venue?.name, from.first_name, editId));
      }
      break;
    }
    case "v":
      r = await setReaction(env, chat, item.id, { status: "seen" });
      toast = T.toastSeen;
      if (inGroup) {
        // « ✅ Je l'ai vu aussi » depuis le groupe : la note se donne en privé, et
        // l'avis sera posté en réponse à ce message du groupe.
        await setSetting(env, threadKey(chat, item.id), String(cq.message.message_id));
        await send(env, chat, T.rateIt(label(item, venue?.name)), keyboard(item, r, lang));
        toast = T.checkPrivate;
      }
      break;
    case "r": {
      const n = Math.max(1, Math.min(5, Number(arg) || 0));
      r = await setReaction(env, chat, item.id, { status: "seen", rating: n });
      toast = T.toastRated(stars(n));
      ctx.waitUntil((async () => {
        await askReview(env, chat, item, lang, T.askComment(stars(n), esc(item.title)));
        if (prev?.rating !== n) await announceReview(env, item, venue?.name, chat, from.first_name, n, prev?.comment ?? null);
      })());
      break;
    }
    case "w":
      // « ✍️ Écrire / modifier mon avis » : rouvre une invitation pour cet item.
      await askReview(env, chat, item, lang, T.askReview(esc(item.title)));
      return void (await answer());
    case "x":
      r = await setReaction(env, chat, item.id, { status: "ignored" });
      toast = T.toastIgnored;
      socialChanged = !!prev?.interested;
      break;
    case "u":
      r = await setReaction(env, chat, item.id, { status: null, rating: null, comment: null });
      toast = T.toastUndo;
      break;
    default:
      return void (await answer());
  }

  // Mon propre message (la notif cliquée, ou ma notif si j'ai cliqué depuis le groupe).
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const mine = await myDelivery(env, chat, item.id);
  if (inGroup) {
    if (mine?.message_id) {
      const v = renderFor(item, chat, r, friends, mine.header, lang);
      await edit(env, chat, mine.message_id, v.text, v.reply_markup);
    }
  } else if (cq.message?.message_id) {
    const clicked = cq.message.message_id;
    const fromList = /^🔕 (Ignorés|Ignored)/.test(cq.message.text ?? "");
    if (fromList) {
      // « ↩️ » depuis /ignores : on retire ce bouton de la liste…
      const rows = (cq.message.reply_markup?.inline_keyboard ?? [])
        .filter((row: any[]) => row[0]?.callback_data !== data);
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: clicked, reply_markup: { inline_keyboard: rows } });
      // … et on remet la notif d'origine en état.
      if (mine?.message_id) {
        const v = renderFor(item, chat, r, friends, mine.header, lang);
        await edit(env, chat, mine.message_id, v.text, v.reply_markup);
      }
    } else {
      const v = renderFor(item, chat, r, friends, mine && mine.message_id === clicked ? mine.header : null, lang);
      await edit(env, chat, clicked, v.text, v.reply_markup);
    }
  }
  await answer(toast);
  if (socialChanged) ctx.waitUntil(refreshAll(env, item, inGroup ? null : chat));
}

// ---------------------------------------------------------------------------
/** Invitation à laisser un avis : force_reply (Telegram ouvre la réponse à CE
 *  message, avec « Ton avis sur X… » dans le champ) ; message_id -> item. */
async function askReview(env: Env, chat: number, item: Item, lang: Lang, text: string): Promise<void> {
  const res = await tg(env, "sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { force_reply: true, input_field_placeholder: tr(lang).reviewPlaceholder(item.title).slice(0, 64) },
  });
  const id = res?.result?.message_id;
  if (id) {
    await env.DB.prepare("INSERT OR REPLACE INTO review_prompts (chat_id, message_id, item_id) VALUES (?, ?, ?)")
      .bind(chat, id, item.id).run();
  }
}

async function onComment(
  env: Env, chat: number, name: string, itemId: string, text: string, ctx: ExecutionContext, lang: Lang,
): Promise<void> {
  const item = await getItem(env, itemId);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat),
    env.DB.prepare("UPDATE review_prompts SET closed = 1 WHERE chat_id = ? AND item_id = ?").bind(chat, itemId),
  ]);
  if (!item) return;
  const comment = text.slice(0, 500);
  const r = await setReaction(env, chat, item.id, { status: "seen", comment });
  await send(env, chat, tr(lang).commentSaved(esc(item.title)));
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  ctx.waitUntil((async () => {
    await announceReview(env, item, venue?.name, chat, name, r.rating, comment);
    await refreshAll(env, item, null);
  })());
}

export { socialBlock, type Friend };
