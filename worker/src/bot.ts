// Webhook Telegram : commandes, boutons ⭐ / ✅ / 🔕, notes, petits mots.
import {
  Env, Friend, Item, Reaction, edit, esc, friendsByItem, getItem, getReaction, renderFor,
  send, setSetting, setting, socialBlock, stars, tg,
} from "./lib";
import { digestFor } from "./scan";
import { Lang, asLang, guessLang, langKeyboard, tr } from "./i18n";

interface TgUser { id: number; first_name: string; username?: string; language_code?: string }

const help = (env: Env, chat: number, lang: Lang) => tr(lang).help + (isOwner(env, chat) ? tr(lang).ownerHelp : "");

/** Langue des annonces du groupe : celle de qui a tapé /groupe. */
const groupLang = async (env: Env): Promise<Lang> => asLang(await setting(env, "group_lang"));

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
    // Dans un groupe, on n'écoute que la commande d'admin /groupe.
    if (cmd === "/groupe" && isOwner(env, from.id)) {
      const owner = await getUser(env, from.id);
      const lang = owner ? asLang(owner.lang) : guessLang(from.language_code);
      await setSetting(env, "group_chat_id", String(msg.chat.id));
      await setSetting(env, "group_lang", lang);
      await send(env, msg.chat.id, tr(lang).groupOn);
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
    case "/programme": {
      for (const m of await digestFor(env, chat, null, T.nowShowing, lang)) await send(env, chat, m);
      return;
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
      await env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat).run();
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

  if (!cmd && user.pending_item) return onComment(env, chat, user.first_name, user.pending_item, text, ctx, lang);
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
const KIND_ICON: Record<string, string> = { theatre: "🎭", expo: "🖼", cinema: "🎬" };

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
     WHERE r.interested = 1 AND r.status IS NULL AND i.last_seen >= datetime(?2, '-2 days')
     GROUP BY i.id ORDER BY n DESC, i.title LIMIT 30`,
  ).bind(chat, since).all<any>();
  if (!results.length) return T.noInterests;
  const friends = await friendsByItem(env, results.map((r) => r.id));
  const lines = results.map((r) => {
    const t = r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title);
    const who = (friends.get(r.id) ?? []).filter((f) => f.interested && !f.status)
      .map((f) => (f.chat_id === chat ? T.youBold : esc(f.first_name))).join(", ");
    return `${r.kind === "expo" ? "🖼" : "🎭"} ${t} <i>(${esc(r.venue)})</i>\n   ⭐ ${who}`;
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
async function announce(env: Env, make: (T: ReturnType<typeof tr>) => string, item?: Item): Promise<void> {
  const group = await setting(env, "group_chat_id");
  if (!group) return;
  const T = tr(await groupLang(env));
  await send(env, group, make(T), item ? {
    inline_keyboard: [[{ text: T.meToo, callback_data: `i:${item.id}` }]],
  } : undefined);
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
    await edit(env, cq.message.chat.id, cq.message.message_id, T.langSet);
    await answer();
    // Inscription : l'accueil est parti en français ; on le redonne dans la langue choisie.
    if (onboarding && lang !== "fr") {
      await send(env, chat, T.welcome(esc(from.first_name)) + help(env, chat, lang) + "\n\n" + T.noSpam);
      await send(env, chat, T.defaultAll, await followKeyboard(env, chat, lang));
    }
    return;
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
        ctx.waitUntil(announce(env, (G) => G.annStar(esc(from.first_name), label(item, venue?.name)), item));
      }
      break;
    }
    case "v":
      r = await setReaction(env, chat, item.id, { status: "seen" });
      toast = T.toastSeen;
      break;
    case "r": {
      const n = Math.max(1, Math.min(5, Number(arg) || 0));
      r = await setReaction(env, chat, item.id, { status: "seen", rating: n });
      await env.DB.prepare("UPDATE users SET pending_item = ? WHERE chat_id = ?").bind(item.id, chat).run();
      toast = T.toastRated(stars(n));
      ctx.waitUntil((async () => {
        await send(env, chat, T.askComment(stars(n), esc(item.title)));
        if (!prev?.rating) await announce(env, (G) => G.annSeen(esc(from.first_name), label(item, venue?.name), stars(n)));
      })());
      break;
    }
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
    if (op === "i") {
      const others = friends.filter((f) => f.interested && !f.status);
      const G = tr(await groupLang(env));
      await edit(env, cq.message.chat.id, cq.message.message_id,
        `⭐ ${label(item, venue?.name)}\n${G.interestedList} ${others.map((f) => esc(f.first_name)).join(", ")}`,
        { inline_keyboard: [[{ text: G.meToo, callback_data: `i:${item.id}` }]] });
    }
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
async function onComment(
  env: Env, chat: number, name: string, itemId: string, text: string, ctx: ExecutionContext, lang: Lang,
): Promise<void> {
  const item = await getItem(env, itemId);
  await env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat).run();
  if (!item) return;
  const comment = text.slice(0, 500);
  const r = await setReaction(env, chat, item.id, { comment });
  await send(env, chat, tr(lang).thanksComment);
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  ctx.waitUntil((async () => {
    await announce(env, (G) => `${G.annComment(esc(name), label(item, venue?.name))}${r.rating ? ` ${stars(r.rating)}` : ""} :\n« ${esc(comment)} »`);
    await refreshAll(env, item, null);
  })());
}

export { socialBlock, type Friend };
