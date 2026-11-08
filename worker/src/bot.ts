// Webhook Telegram : commandes, boutons ⭐ / ✅ / 🔕, notes, petits mots.
import {
  Env, Friend, Item, Reaction, edit, esc, friendsByItem, getItem, getReaction, renderFor,
  send, setSetting, setting, socialBlock, stars, tg,
} from "./lib";
import { digestFor } from "./scan";

interface TgUser { id: number; first_name: string; username?: string }

const isOwner = (env: Env, id: number) => String(id) === String(env.OWNER_CHAT_ID);

async function getUser(env: Env, chat_id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chat_id)
    .first<{ chat_id: number; first_name: string; active: number; pending_item: string | null }>();
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

const HELP = `🎭 <b>Comment ça marche</b>

Je t'envoie les nouvelles pièces (surtitrées en anglais) et expos des lieux que tu suis. Sous chaque notif :
⭐ <b>Intéressé·e</b> : la bande voit que ça te tente (et toi, qui d'autre est partant)
✅ <b>Vu</b> : plus de notif, et tu peux noter ★ + laisser un petit mot
🔕 <b>Ignorer</b> : plus jamais de notif sur cette pièce/expo, même quand elle revient

/suivre — choisir ses théâtres et lieux d'expo
/programme — tout ce qui est à l'affiche dans tes lieux
/interets — ce qui tente la bande
/vus — ce que tu as vu et tes notes
/ignores — réactiver une pièce/expo ignorée
/stop — ne plus rien recevoir`;

const OWNER_HELP = `\n\n👑 <b>Admin</b>
/invite — lien d'invitation à partager
/nouveaulien — invalider l'ancien lien
/membres — qui est inscrit
/groupe — (à taper DANS un groupe Telegram) y annoncer les ⭐ et les avis
/plusdegroupe — arrêter les annonces dans le groupe`;

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
      await setSetting(env, "group_chat_id", String(msg.chat.id));
      await send(env, msg.chat.id, "👋 C'est noté : j'annoncerai ici les ⭐ de la bande et les avis après spectacle.");
    }
    return;
  }

  const chat = from.id;
  const user = await getUser(env, chat);

  if (cmd === "/start") return onStart(env, from, user, args[0]);
  if (!user || !user.active) {
    await send(env, chat, user
      ? "Tu t'étais désinscrit·e. Tape /start pour revenir 🙂"
      : "🔒 Ce bot est réservé à une bande d'amis. Demande le lien d'invitation à la personne qui t'en a parlé.");
    return;
  }

  switch (cmd) {
    case "/suivre": return void (await send(env, chat, "Que veux-tu suivre ? Touche pour cocher / décocher :", await followKeyboard(env, chat)));
    case "/programme": {
      for (const m of await digestFor(env, chat, null, "📅 <b>À l'affiche</b>")) await send(env, chat, m);
      return;
    }
    case "/interets": return void (await send(env, chat, await interestsText(env, chat)));
    case "/vus": return void (await send(env, chat, await seenText(env, chat)));
    case "/ignores": return onIgnored(env, chat);
    case "/stop":
      await env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?").bind(chat).run();
      return void (await send(env, chat, "🔕 C'est fait, tu ne recevras plus rien. /start pour revenir."));
    case "/passer":
      await env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat).run();
      return void (await send(env, chat, "👌"));
    case "/aide": case "/help":
      return void (await send(env, chat, HELP + (isOwner(env, chat) ? OWNER_HELP : "")));
  }

  if (isOwner(env, chat)) {
    if (cmd === "/invite") return void (await send(env, chat, await inviteText(env)));
    if (cmd === "/nouveaulien") {
      await setSetting(env, "invite_code", randomCode());
      return void (await send(env, chat, "🔁 Ancien lien désactivé.\n\n" + await inviteText(env)));
    }
    if (cmd === "/membres") return void (await send(env, chat, await membersText(env)));
    if (cmd === "/plusdegroupe") {
      await setSetting(env, "group_chat_id", null);
      return void (await send(env, chat, "OK, plus d'annonces dans le groupe."));
    }
  }

  if (!cmd && user.pending_item) return onComment(env, chat, user.first_name, user.pending_item, text, ctx);
  await send(env, chat, "Je n'ai pas compris 🙂 /aide pour la liste des commandes.");
}

// ---------------------------------------------------------------------------
async function onStart(env: Env, from: TgUser, user: any, code?: string): Promise<void> {
  const chat = from.id;
  if (user) {
    if (!user.active) await env.DB.prepare("UPDATE users SET active = 1 WHERE chat_id = ?").bind(chat).run();
    await send(env, chat, `Re-bonjour ${esc(from.first_name)} 👋\n\n${HELP}`);
    return;
  }
  const valid = isOwner(env, chat) || (code && code === await setting(env, "invite_code"));
  if (!valid) {
    await send(env, chat, "🔒 Ce lien d'invitation n'est pas (ou plus) valable. Demande-en un nouveau.");
    return;
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (chat_id, first_name, username) VALUES (?, ?, ?)")
      .bind(chat, from.first_name, from.username ?? null),
    // Par défaut : tout. Le premier scan enregistre le catalogue en silence.
    env.DB.prepare("INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed) SELECT ?, id, 0 FROM venues WHERE active = 1")
      .bind(chat),
  ]);
  await send(env, chat,
    `Bienvenue ${esc(from.first_name)} 🎉\n\n${HELP}\n\n` +
    "Pour ne pas t'inonder, je ne t'envoie pas le programme actuel en notifs : seulement les nouveautés à partir de demain. Tape /programme pour voir ce qui est déjà à l'affiche.");
  await send(env, chat, "Par défaut tu suis tout. Décoche ce qui ne t'intéresse pas :", await followKeyboard(env, chat));
  if (!isOwner(env, chat) && env.OWNER_CHAT_ID) {
    await send(env, env.OWNER_CHAT_ID, `🎉 ${esc(from.first_name)}${from.username ? ` (@${esc(from.username)})` : ""} a rejoint le bot.`);
  }
}

async function inviteText(env: Env): Promise<string> {
  const link = `https://t.me/${env.BOT_USERNAME}?start=${await inviteCode(env)}`;
  return `🔗 Lien d'invitation à partager avec tes amis :\n${link}\n\nIls ouvrent le lien, appuient sur « Démarrer », et c'est tout. /nouveaulien pour l'invalider.`;
}

async function membersText(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT u.first_name, u.username, u.active,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id) AS subs,
       (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.interested = 1) AS stars
     FROM users u ORDER BY u.joined_at`,
  ).all<any>();
  const group = await setting(env, "group_chat_id");
  return `👥 <b>${results.filter((r) => r.active).length} membre(s)</b>\n` +
    results.map((r) => `${r.active ? "•" : "✖️"} ${esc(r.first_name)}${r.username ? ` @${esc(r.username)}` : ""} — ${r.subs} lieu(x), ${r.stars} ⭐`).join("\n") +
    `\n\nGroupe d'annonces : ${group ? "activé" : "aucun (/groupe dans un groupe)"}`;
}

// ---------------------------------------------------------------------------
// /suivre
// ---------------------------------------------------------------------------
async function followKeyboard(env: Env, chat: number): Promise<unknown> {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind, (s.chat_id IS NOT NULL) AS on_ FROM venues v
     LEFT JOIN subscriptions s ON s.venue_id = v.id AND s.chat_id = ?
     WHERE v.active = 1 ORDER BY v.kind DESC, v.position`,
  ).bind(chat).all<{ id: string; name: string; kind: string; on_: number }>();
  if (!results.length) {
    return { inline_keyboard: [[{ text: "Aucun lieu encore — réessaie après le prochain scan", callback_data: "sd" }]] };
  }
  const rows = results.map((v) => [{
    text: `${v.on_ ? "✅" : "⬜️"} ${v.kind === "expo" ? "🖼" : "🎭"} ${v.name}`,
    callback_data: `s:${v.id}`,
  }]);
  rows.push([
    { text: "Tout ✅", callback_data: "sa" },
    { text: "Rien ⬜️", callback_data: "sn" },
    { text: "Terminé 👍", callback_data: "sd" },
  ]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------
async function interestsText(env: Env, chat: number): Promise<string> {
  const since = (await setting(env, "current_since")) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.url, v.name AS venue, COUNT(*) AS n,
       MAX(r.chat_id = ?1) AS mine
     FROM reactions r JOIN users u ON u.chat_id = r.chat_id AND u.active = 1
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.interested = 1 AND r.status IS NULL AND i.last_seen >= datetime(?2, '-2 days')
     GROUP BY i.id ORDER BY n DESC, i.title LIMIT 30`,
  ).bind(chat, since).all<any>();
  if (!results.length) return "Personne n'a encore mis ⭐ sur une pièce ou une expo à l'affiche.";
  const friends = await friendsByItem(env, results.map((r) => r.id));
  const lines = results.map((r) => {
    const t = r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title);
    const who = (friends.get(r.id) ?? []).filter((f) => f.interested && !f.status)
      .map((f) => (f.chat_id === chat ? "<b>toi</b>" : esc(f.first_name))).join(", ");
    return `${r.kind === "expo" ? "🖼" : "🎭"} ${t} <i>(${esc(r.venue)})</i>\n   ⭐ ${who}`;
  });
  return `⭐ <b>Ce qui tente la bande</b>\n\n${lines.join("\n")}`;
}

async function seenText(env: Env, chat: number): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT i.title, i.kind, r.rating, r.comment, v.name AS venue FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status = 'seen' ORDER BY r.updated_at DESC LIMIT 40`,
  ).bind(chat).all<any>();
  if (!results.length) return "Rien de marqué ✅ Vu pour l'instant.";
  return "✅ <b>Tes sorties</b>\n\n" + results.map((r) =>
    `${r.kind === "expo" ? "🖼" : "🎭"} ${esc(r.title)} <i>(${esc(r.venue)})</i>${r.rating ? ` ${stars(r.rating)}` : ""}` +
    (r.comment ? `\n   « ${esc(r.comment)} »` : "")).join("\n");
}

async function onIgnored(env: Env, chat: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.title, v.name AS venue FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status = 'ignored' ORDER BY r.updated_at DESC LIMIT 20`,
  ).bind(chat).all<any>();
  if (!results.length) return void (await send(env, chat, "Tu n'ignores rien pour l'instant."));
  await send(env, chat, "🔕 <b>Ignorés</b> — touche pour réactiver les notifs :", {
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
    `SELECT d.chat_id, d.message_id, d.header FROM deliveries d JOIN users u ON u.chat_id = d.chat_id
     WHERE d.item_id = ? AND d.message_id IS NOT NULL AND u.active = 1 ORDER BY d.sent_at DESC LIMIT 40`,
  ).bind(item.id).all<{ chat_id: number; message_id: number; header: string | null }>();
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const reactions = new Map(friends.map((f) => [f.chat_id, f as Reaction]));
  const { results: others } = await env.DB.prepare("SELECT * FROM reactions WHERE item_id = ?").bind(item.id).all<Reaction>();
  for (const r of others) reactions.set(r.chat_id, r);
  for (const d of results) {
    if (d.chat_id === except) continue;
    const view = renderFor(item, d.chat_id, reactions.get(d.chat_id) ?? null, friends, d.header);
    await edit(env, d.chat_id, d.message_id, view.text, view.reply_markup);
  }
}

async function myDelivery(env: Env, chat: number, item: string) {
  return env.DB.prepare("SELECT message_id, header FROM deliveries WHERE chat_id = ? AND item_id = ?")
    .bind(chat, item).first<{ message_id: number | null; header: string | null }>();
}

async function announce(env: Env, text: string, item?: Item): Promise<void> {
  const group = await setting(env, "group_chat_id");
  if (!group) return;
  await send(env, group, text, item ? {
    inline_keyboard: [[{ text: "⭐ Moi aussi", callback_data: `i:${item.id}` }]],
  } : undefined);
}

function label(item: Item, venueName?: string): string {
  const t = item.url ? `<a href="${esc(item.url)}">${esc(item.title)}</a>` : `<b>${esc(item.title)}</b>`;
  return `${item.kind === "expo" ? "🖼" : "🎭"} ${t}${venueName ? ` (${esc(venueName)})` : ""}`;
}

async function onCallback(env: Env, cq: any, ctx: ExecutionContext): Promise<void> {
  const from: TgUser = cq.from;
  const chat = from.id;
  const data: string = cq.data ?? "";
  const answer = (text?: string, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });

  const user = await getUser(env, chat);
  if (!user?.active) {
    return void (await answer(`Ouvre d'abord le bot en privé (@${env.BOT_USERNAME}) avec le lien d'invitation 🙂`, true));
  }

  // --- /suivre -----------------------------------------------------------
  if (data === "sd") {
    await edit(env, cq.message.chat.id, cq.message.message_id, "👍 C'est enregistré. /suivre pour changer plus tard.");
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
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: await followKeyboard(env, chat),
    });
    return void (await answer());
  }

  // --- réactions sur une pièce/expo ----------------------------------------
  const [op, itemId, arg] = data.split(":");
  const item = itemId ? await getItem(env, itemId) : null;
  if (!item) return void (await answer("Cette pièce n'est plus au programme."));
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
      toast = on ? "⭐ Noté, la bande est au courant" : "Retiré de tes ⭐";
      if (on && !prev?.interested) {
        ctx.waitUntil(announce(env, `⭐ <b>${esc(from.first_name)}</b> est intéressé·e par ${label(item, venue?.name)}`, item));
      }
      break;
    }
    case "v":
      r = await setReaction(env, chat, item.id, { status: "seen" });
      toast = "✅ Plus de notif sur celle-ci. Une note ?";
      break;
    case "r": {
      const n = Math.max(1, Math.min(5, Number(arg) || 0));
      r = await setReaction(env, chat, item.id, { status: "seen", rating: n });
      await env.DB.prepare("UPDATE users SET pending_item = ? WHERE chat_id = ?").bind(item.id, chat).run();
      toast = `${stars(n)} — merci !`;
      ctx.waitUntil((async () => {
        await send(env, chat, `${stars(n)} pour <b>${esc(item.title)}</b>.\n\nUn petit mot pour la bande ? Écris-le simplement ici (ou /passer).`);
        if (!prev?.rating) await announce(env, `✅ <b>${esc(from.first_name)}</b> a vu ${label(item, venue?.name)} : ${stars(n)}`);
      })());
      break;
    }
    case "x":
      r = await setReaction(env, chat, item.id, { status: "ignored" });
      toast = "🔕 Ignoré, même si ça revient";
      socialChanged = !!prev?.interested;
      break;
    case "u":
      r = await setReaction(env, chat, item.id, { status: null, rating: null, comment: null });
      toast = "↩️ C'est annulé";
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
      await edit(env, cq.message.chat.id, cq.message.message_id,
        `⭐ ${label(item, venue?.name)}\nIntéressé·es : ${others.map((f) => esc(f.first_name)).join(", ")}`,
        { inline_keyboard: [[{ text: "⭐ Moi aussi", callback_data: `i:${item.id}` }]] });
    }
    if (mine?.message_id) {
      const v = renderFor(item, chat, r, friends, mine.header);
      await edit(env, chat, mine.message_id, v.text, v.reply_markup);
    }
  } else if (cq.message?.message_id) {
    const clicked = cq.message.message_id;
    const fromList = (cq.message.text ?? "").startsWith("🔕 Ignorés");
    if (fromList) {
      // « ↩️ » depuis /ignores : on retire ce bouton de la liste…
      const rows = (cq.message.reply_markup?.inline_keyboard ?? [])
        .filter((row: any[]) => row[0]?.callback_data !== data);
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: clicked, reply_markup: { inline_keyboard: rows } });
      // … et on remet la notif d'origine en état.
      if (mine?.message_id) {
        const v = renderFor(item, chat, r, friends, mine.header);
        await edit(env, chat, mine.message_id, v.text, v.reply_markup);
      }
    } else {
      const v = renderFor(item, chat, r, friends, mine && mine.message_id === clicked ? mine.header : null);
      await edit(env, chat, clicked, v.text, v.reply_markup);
    }
  }
  await answer(toast);
  if (socialChanged) ctx.waitUntil(refreshAll(env, item, inGroup ? null : chat));
}

// ---------------------------------------------------------------------------
async function onComment(env: Env, chat: number, name: string, itemId: string, text: string, ctx: ExecutionContext): Promise<void> {
  const item = await getItem(env, itemId);
  await env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat).run();
  if (!item) return;
  const comment = text.slice(0, 500);
  const r = await setReaction(env, chat, item.id, { comment });
  await send(env, chat, "💬 Merci, c'est partagé avec la bande !");
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  ctx.waitUntil((async () => {
    await announce(env, `💬 <b>${esc(name)}</b> sur ${label(item, venue?.name)}${r.rating ? ` ${stars(r.rating)}` : ""} :\n« ${esc(comment)} »`);
    await refreshAll(env, item, null);
  })());
}

export { socialBlock, type Friend };
