// Webhook Telegram : commandes, boutons ⭐ / ✅ / 🔕, notes, petits mots.
import {
  Env, Friend, Horizon, Item, Reaction, edit, esc, friendsByItem, getItem, getReaction, horizon, editKeyboard, keyboard, renderFor,
  send, setSetting, setting, socialBlock, stars, tg, whenLabel, windowSql, appHome, appLink, circleSql, visibleTo } from "./lib";
import { codeOwner, connect, connectViaLink, friendCallback, inviteMessage, resetCode } from "./circles";
import { digestFor } from "./scan";
import { openCard } from "./daily";
import { cardMarkup, currentSql, getList, openItem, sendList, showList } from "./list";
import { Lang, MENU_VERSION, asLang, guessLang, langKeyboard, setChatMenu, setGlobalMenus, tr } from "./i18n";
import { confirmWebLogin } from "./app";   // cycle app ↔ bot sans souci : appelé à l'exécution
import {
  announceInterest, announceReview, card, groupChat, groupInterests, groupLang as grpLang, groupProgramme, threadKey,
} from "./group";

interface TgUser { id: number; first_name: string; username?: string; language_code?: string }

const help = (env: Env, chat: number, lang: Lang) => tr(lang).help + (isOwner(env, chat) ? tr(lang).ownerHelp : "");



const isOwner = (env: Env, id: number) => String(id) === String(env.OWNER_CHAT_ID);
/** Bouton « 📖 Ouvrir Berlin Encore! » sous l'accueil et l'aide (privé). */
const appButton = (env: Env, lang: Lang) => ({ inline_keyboard: [[{ text: tr(lang).openAppBtn, url: appHome(env) }]] });

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
  // Nouvelle version du menu : défaut fr/en + groupe reposés une fois (1er update après déploiement).
  if ((await setting(env, "menu_v_global")) !== MENU_VERSION) {
    await setSetting(env, "menu_v_global", MENU_VERSION);
    ctx.waitUntil(setGlobalMenus(env));
  }
  // Activité (pour /membres) : les clics rejoués depuis la mini-app (id « app ») n'en sont pas.
  const actor = update.callback_query?.id !== "app" ? (update.message?.from?.id ?? update.callback_query?.from?.id) : null;
  if (actor) ctx.waitUntil(env.DB.prepare("UPDATE users SET bot_seen_at = datetime('now') WHERE chat_id = ?").bind(actor).run().then(() => {}, () => {}));
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
  // Menu « / » d'une ancienne version : reposé une fois (3 commandes depuis « 3cmd »).
  if ((await setting(env, `menu_v:${chat}`)) !== MENU_VERSION) {
    await setChatMenu(env, chat, lang);
    await setSetting(env, `menu_v:${chat}`, MENU_VERSION);
  }

  switch (cmd) {
    case "/reglages": case "/settings":
      return void (await send(env, chat, T.settingsTitle, settingsKeyboard(lang, isOwner(env, chat))));
    case "/suivre": return void (await send(env, chat, T.followPrompt, await followKeyboard(env, chat, lang)));
    case "/programme": case "/program":
    case "/expos": case "/theatre": case "/theatres": case "/theater": case "/films": {
      // Une liste dépliable, filtre [Tout] [🎭] [🖼] [🎬] en tête (les alias pré-filtrent).
      const f = cmd === "/expos" ? "expo" : cmd === "/films" ? "film" : cmd.startsWith("/theat") ? "theatre" : "all";
      return void (await sendList(env, chat, { k: "prog", p: 0, f }, lang, f === "all" ? T.noFollowedAny : undefined));
    }
    case "/sorties": case "/outings": case "/interets": case "/interests": case "/vus": {
      // Une liste dépliable : chaque ligne s'ouvre en fiche dans ce même message.
      return void (await sendList(env, chat, { k: "sorties", p: 0, head: T.outingsTitle }, lang, T.outEmpty));
    }
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
      return void (await send(env, chat, help(env, chat, lang), appButton(env, lang)));
  }

  // Chacun a son lien personnel : qui s'inscrit avec est connecté·e à lui / elle.
  if (cmd === "/invite" || cmd === "/inviter") return void (await send(env, chat, await inviteMessage(env, chat, user?.lang ?? lang)));
  if (cmd === "/nouveaulien" || cmd === "/newlink") {
    // Lien personnel renouvelé ; pour la propriétaire, l'ancien lien commun aussi.
    await resetCode(env, chat);
    if (isOwner(env, chat)) await setSetting(env, "invite_code", randomCode());
    return void (await send(env, chat, T.newLinkDone + await inviteMessage(env, chat, user?.lang ?? lang)));
  }
  if (isOwner(env, chat)) {
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
      ? await env.DB.prepare("SELECT item_id, kind, message_id FROM review_prompts WHERE chat_id = ? AND message_id = ?")
        .bind(chat, replyTo).first<{ item_id: string; kind: string; message_id: number }>()
      : null;
    const latest = prompt ?? await env.DB.prepare(
      `SELECT item_id, kind, message_id FROM review_prompts WHERE chat_id = ? AND closed = 0
       ORDER BY created_at DESC, message_id DESC LIMIT 1`).bind(chat).first<{ item_id: string; kind: string; message_id: number }>();
    if (latest?.kind === "date") {
      // « 📅 Autre date » : la réponse est une date (14/12 20:00), pas un avis.
      const iso = parseDate(text);
      if (!iso) return void (await send(env, chat, T.bookBadDate));
      await env.DB.prepare("UPDATE review_prompts SET closed = 1 WHERE chat_id = ? AND message_id = ?")
        .bind(chat, latest.message_id).run();
      const it = await getItem(env, latest.item_id);
      if (!it) return;
      const r2 = await book(env, chat, user.first_name, it, iso, lang, ctx);
      const card = await promptCard(env, chat, latest.message_id);
      if (card) {
        await restore(env, chat, it, r2, card.id, card.where, lang);
        await cleanup(env, chat, latest.message_id, msg.message_id);
      } else {
        await refreshMine(env, chat, it, r2, lang);
        await send(env, chat, T.booked(esc(it.title), whenLabel(iso, lang)));
      }
      return;
    }
    const itemId = latest?.item_id ?? user.pending_item;
    if (itemId) return onComment(env, chat, user.first_name, itemId, text, ctx, lang, latest?.message_id ?? null, msg.message_id);
  }
  await send(env, chat, T.notUnderstood);
}

// ---------------------------------------------------------------------------
async function onStart(env: Env, from: TgUser, user: any, code?: string): Promise<void> {
  const chat = from.id;
  // App web : « Se connecter avec Telegram » ouvre t.me/<bot>?start=web_<nonce> (app.ts).
  // On demande confirmation : un lien reçu d'un inconnu ne connecte pas son navigateur à mon compte.
  const web = code?.match(/^web_([a-f0-9]{24})$/);
  if (web) {
    const T = tr(user ? user.lang : guessLang(from.language_code));
    if (!user?.active) return void (await send(env, chat, T.privateBot));
    return void (await send(env, chat, T.webLoginAsk, { inline_keyboard: [[{ text: T.webLoginBtn, callback_data: `wl:${web[1]}` }]] }));
  }
  // Lien PERSONNEL de quelqu'un (circles.ts) : inscription + connexion à cette personne.
  const inviter = await codeOwner(env, code);
  if (user) {
    const lang = asLang(user.lang);
    if (!user.active) await env.DB.prepare("UPDATE users SET active = 1 WHERE chat_id = ?").bind(chat).run();
    if (inviter && inviter !== chat) return void (await connectViaLink(env, chat, inviter));
    await send(env, chat, tr(lang).welcomeBack(esc(from.first_name)) + help(env, chat, lang), appButton(env, lang));
    return;
  }
  const valid = isOwner(env, chat) || !!inviter || (code && code === await setting(env, "invite_code"));
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
  // Connecté·e à qui l'a invité·e (lien personnel), sinon à la propriétaire (ancien lien commun).
  const sponsor = inviter ?? (!isOwner(env, chat) && env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : null);
  if (sponsor) await connect(env, chat, sponsor);
  // Langue par défaut : français (users.lang). Le choix est proposé tout de suite.
  await setChatMenu(env, chat, "fr");
  const T = tr("fr");
  await send(env, chat, T.welcome(esc(from.first_name)) + help(env, chat, "fr"), appButton(env, "fr"));
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
    `SELECT u.first_name, u.username, u.active, u.lang, u.bot_seen_at, u.app_seen_at,
       (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id) AS subs,
       (SELECT COUNT(*) FROM reactions r WHERE r.chat_id = u.chat_id AND r.interested = 1) AS stars
     FROM users u ORDER BY u.joined_at`,
  ).all<any>();
  const group = await setting(env, "group_chat_id");
  // Actif·ve = un clic / message dans le bot ou une ouverture de l'app depuis 7 jours.
  const ago = (d: string | null) => d ? Math.floor((Date.now() - Date.parse(d.replace(" ", "T") + "Z")) / 864e5) : null;
  const last = (r: any) => [ago(r.bot_seen_at), ago(r.app_seen_at)].filter((x) => x !== null) as number[];
  const active7 = results.filter((r) => r.active && last(r).some((d) => d < 7)).length;
  const app7 = results.filter((r) => r.active && ago(r.app_seen_at) !== null && ago(r.app_seen_at)! < 7).length;
  return T.members(results.filter((r) => r.active).length) + T.activity(active7, app7) +
    results.map((r) => `${r.active ? "•" : "✖️"} ${esc(r.first_name)}${r.username ? ` @${esc(r.username)}` : ""}` +
      ` ${r.lang === "en" ? "🇬🇧" : "🇫🇷"} — ${T.memberLine(r.subs, r.stars)}` +
      ` · ${T.lastSeen(last(r).length ? Math.min(...last(r)) : null, ago(r.app_seen_at) !== null)}`).join("\n") +
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

/** /reglages : un message, quatre boutons (lieux, langue, pas pour moi, groupe). */
// 👥 Groupe : seulement pour l'admin (relier / délier le groupe de la bande).
const settingsKeyboard = (lang: Lang, owner = false) => {
  const T = tr(lang);
  return { inline_keyboard: [
    [{ text: T.setVenues, callback_data: "st:v" }, { text: T.setLang, callback_data: "st:l" }],
    [{ text: T.setIgnored, callback_data: "st:i" }, ...(owner ? [{ text: T.setGroup, callback_data: "st:g" }] : [])],
  ] };
};

// ---------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------
/** /sorties : UNE liste — 🎟 réservé (date ↑), ⭐ intéressé·e, ✅ vu (10 derniers, ma note).
 *  Boutons : 🎟 / ✅ / ✖ pour réservé et ⭐ ; ★ (noter) ou ✍️ (avis) pour le vu. */
async function outings(env: Env, chat: number, lang: Lang): Promise<{ text: string; kb?: unknown }> {
  const T = tr(lang);
  const since = (await setting(env, "current_since")) ?? "";
  const { results: active } = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.url, v.name AS venue, r.booked_at FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE r.chat_id = ?1 AND r.interested = 1 AND r.status IS NULL
       AND (r.booked_at IS NOT NULL AND substr(r.booked_at, 1, 10) >= date('now')
            OR CASE WHEN i.kind = 'film' THEN (SELECT MAX(value) FROM json_each(i.dates)) >= date('now')
                    ELSE i.last_seen >= datetime(?2, '-2 days') END)
     ORDER BY r.booked_at IS NULL, r.booked_at, i.title LIMIT 25`,
  ).bind(chat, since).all<any>();
  const { results: seen } = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.url, v.name AS venue, r.rating, r.comment FROM reactions r
     JOIN items i ON i.id = r.item_id JOIN venues v ON v.id = i.venue_id
     WHERE r.chat_id = ? AND r.status = 'seen' ORDER BY r.updated_at DESC LIMIT 10`,
  ).bind(chat).all<any>();
  if (!active.length && !seen.length) return { text: T.outEmpty };
  const friends = await friendsByItem(env, active.map((r) => r.id));
  const link = (r: any) => r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title);
  const others = (id: string) => visibleTo(friends.get(id) ?? [], chat).filter((f) => f.interested && !f.status && f.chat_id !== chat)
    .map((f) => esc(f.first_name)).join(", ");
  const line = (r: any, when = "") => {
    const o = others(r.id);
    return `${KIND_ICON[r.kind] ?? "🎭"} ${link(r)}${when} <i>(${esc(r.venue)})</i>${o ? `\n   👥 ${o}` : ""}`;
  };
  const booked = active.filter((r) => r.booked_at);
  const keen = active.filter((r) => !r.booked_at);
  const parts = [T.outingsTitle];
  if (booked.length) parts.push(`${T.outBooked}\n` + booked.map((r) => line(r, ` — ${whenLabel(r.booked_at, lang)}`)).join("\n"));
  if (keen.length) parts.push(`${T.outInterested}\n` + keen.map((r) => line(r)).join("\n"));
  if (seen.length) {
    parts.push(`${T.outSeen}\n` + seen.map((r) => `${KIND_ICON[r.kind] ?? "🎭"} ${link(r)}${r.rating ? ` ${stars(r.rating)}` : ""}`
      + (r.comment ? `\n   « ${esc(r.comment)} »` : "")).join("\n"));
  }
  // Une ligne = un bouton pleine largeur (Telegram donne la même largeur à chaque
  // bouton d'une ligne) : « 🎭 Titre · 🎟 » -> sélecteur de dates (+ ✅ Déjà vu / ✖ Retirer).
  const short = (t: string) => (t.length > 34 ? t.slice(0, 33) + "…" : t);
  const icon = (r: any) => KIND_ICON[r.kind] ?? "🎭";
  const rows: any[][] = active.map((r) => [{
    text: `${icon(r)} ${short(r.title)} · 🎟${r.booked_at ? ` ${whenLabel(r.booked_at.slice(0, 10), lang)}` : ""}`,
    callback_data: `b:${r.id}`,
  }]);
  for (const r of seen) {
    rows.push([{ text: `${icon(r)} ${short(r.title)} · ${r.rating ? "✍️" : "★"}`, callback_data: `rt:${r.id}` }]);
  }
  return { text: parts.join("\n\n").slice(0, 4000), kb: rows.length ? { inline_keyboard: rows.slice(0, 40) } : undefined };
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
    { chat_id: chat, item_id: item, interested: 0, status: null, rating: null, comment: null,
      booked_at: null, booked_on: null, followup_sent: 0 };
  const next = { ...cur, ...patch };
  await env.DB.prepare(
    `INSERT INTO reactions (chat_id, item_id, interested, status, rating, comment, booked_at, booked_on, followup_sent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id, item_id) DO UPDATE SET interested = excluded.interested, status = excluded.status,
       rating = excluded.rating, comment = excluded.comment, booked_at = excluded.booked_at,
       booked_on = excluded.booked_on, followup_sent = excluded.followup_sent, updated_at = excluded.updated_at`,
  ).bind(chat, item, next.interested, next.status, next.rating, next.comment,
    next.booked_at ?? null, next.booked_on ?? null, next.followup_sent ?? 0).run();
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
const current = currentSql;

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
     JOIN items i ON i.id = r.item_id WHERE r.interested = 1 AND r.status IS NULL AND ${circleSql("r.chat_id", "?1")}
       AND ${current(await horizon(env), true)}`,
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
                 WHERE r.item_id = i.id AND r.interested = 1 AND r.status IS NULL AND ${circleSql("r.chat_id", "?1")}) AND ?3 = ?3`
      : "i.kind = ?3";
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
     WHERE ${cur} AND ${where}
     ORDER BY ${value === "star" ? `(SELECT MIN(b.booked_at) FROM reactions b WHERE b.item_id = i.id AND b.booked_at IS NOT NULL
                  AND b.status IS NULL) IS NULL,` : ""}
       CASE i.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position,
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
  if (cq.message?.chat?.type === "private" && (await setting(env, `menu_v:${chat}`)) !== MENU_VERSION) {
    await setChatMenu(env, chat, lang);
    await setSetting(env, `menu_v:${chat}`, MENU_VERSION);
  }

  // --- demandes d'ami (circles.ts) ------------------------------------------
  if (/^f[ax]:/.test(data)) return void (await friendCallback(env, cq, chat, user.lang));
  // --- connexion de l'app web (app.ts) ----------------------------------------
  if (/^wl:[a-f0-9]{24}$/.test(data)) {
    const ok = await confirmWebLogin(env, data.slice(3), chat);
    if (cq.message?.message_id) await edit(env, cq.message.chat.id, cq.message.message_id, ok ? T.webLoginDone : T.webLoginExpired);
    return void (await answer(ok ? T.webLoginDone : T.webLoginExpired));
  }

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
      await send(env, chat, T.welcome(esc(from.first_name)) + help(env, chat, lang), appButton(env, lang));
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

  // --- /reglages ----------------------------------------------------------
  if (data.startsWith("st:")) {
    await answer();
    const k = data.slice(3);
    if (k === "v") return void (await send(env, chat, T.followPrompt, await followKeyboard(env, chat, lang)));
    if (k === "l") return void (await send(env, chat, T.langPrompt, langKeyboard()));
    if (k === "i") return onIgnored(env, chat, lang);
    if (k === "g" && isOwner(env, chat)) return void (await send(env, chat, T.groupInfo(!!(await groupChat(env)))));
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
  // --- listes dépliables (list.ts) ------------------------------------------
  if (data === "ln") return void (await answer());
  if (/^l[pbf](:|$)/.test(data) && cq.message?.message_id) {
    const msg = cq.message.message_id;
    const st = await getList(env, chat, msg);
    if (!st) return void (await answer(T.gone));
    if (data.startsWith("lp:")) st.p = Number(data.slice(3)) || 0;
    if (data.startsWith("lf:")) { st.f = data.slice(3); st.p = 0; }
    await showList(env, chat, msg, st, lang);
    return void (await answer());
  }

  const [op, itemId, arg] = data.split(":");
  const item = itemId ? await getItem(env, itemId) : null;
  if (!item) return void (await answer(T.gone));
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  const prev = await getReaction(env, chat, item.id);
  const inGroup = cq.message?.chat?.type !== "private";
  // Depuis la mini-app : rien n'est posté au groupe (⭐, note, réservation). On n'écrit
  // aux autres que quand on clique « Envoyer à… ».
  const quiet = cq.id === "app";
  let r: Reaction;
  let toast = "";
  let socialChanged = true;

  // --- 🎟 réservations ------------------------------------------------------
  // Une fiche = un message qui évolue : 🎟 transforme CE message (fiche, ou /sorties) en
  // sélecteur ; date / ↩︎ / annuler le remettent en fiche (ou en liste). `where` : "o" = /sorties.
  const clickedId: number | null = cq.message?.message_id ?? null;
  const where = data.split(":")[3] === "o" || (op !== "bd" && arg === "o") ? "o" : "c";
  if (op === "b") {
    if (inGroup || !clickedId) {
      // Pas de sélecteur dans le groupe (message partagé) : en privé, sur ma fiche.
      const mine = await myDelivery(env, chat, item.id);
      const text = pickerText(item, venue?.name, lang);
      if (mine?.message_id) await edit(env, chat, mine.message_id, text, bookPicker(item, prev, lang, "c"));
      else await send(env, chat, text, bookPicker(item, prev, lang, "c"));
      return void (await answer(inGroup ? T.checkPrivate : undefined));
    }
    const o = /^🗂 (Mes sorties|My outings)/.test(cq.message?.text ?? "") ? "o" : "c";
    await edit(env, chat, clickedId, pickerText(item, venue?.name, lang), bookPicker(item, prev, lang, o));
    return void (await answer());
  }
  if (op === "lo") {
    const st = clickedId ? await getList(env, chat, clickedId) : null;
    if (st && clickedId) await openItem(env, chat, clickedId, st, item, lang);
    else await openCard(env, chat, item, lang);
    return void (await answer());
  }
  if (op === "oc") {
    // Ligne du lot du matin : la fiche complète, en message à part.
    await openCard(env, chat, item, lang);
    return void (await answer());
  }
  if (op === "ed" || op === "eb") {
    // ✏️ Modifier : la fiche montre 1–5★ + réécrire + ↩︎ ; ↩︎ la remet telle quelle.
    if (clickedId) {
      const mine = await myDelivery(env, chat, item.id);
      const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
      const v = renderFor(item, chat, prev, friends, mine?.message_id === clickedId ? mine.header : null, lang);
      await edit(env, chat, clickedId, v.text,
        await cardMarkup(env, chat, clickedId, op === "ed" ? editKeyboard(item, prev, lang) : v.reply_markup, lang));
    }
    return void (await answer());
  }
  if (op === "bb") {
    if (clickedId) await restore(env, chat, item, prev, clickedId, where, lang);
    return void (await answer());
  }
  if (op === "bd") {
    const r2 = await book(env, chat, from.first_name, item, decodeWhen(arg), lang, ctx, quiet);
    if (clickedId) await restore(env, chat, item, r2, clickedId, where, lang);
    return void (await answer(T.toastBooked(whenLabel(decodeWhen(arg), lang))));
  }
  if (op === "bo") {
    const res = await tg(env, "sendMessage", {
      chat_id: chat, text: T.bookAskDate(esc(item.title)), parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: T.bookDatePlaceholder.slice(0, 64) },
    });
    const id = res?.result?.message_id;
    if (id) {
      await env.DB.prepare("INSERT OR REPLACE INTO review_prompts (chat_id, message_id, item_id, kind) VALUES (?, ?, ?, 'date')")
        .bind(chat, id, item.id).run();
      if (clickedId) await setSetting(env, cardKey(chat, id), `${clickedId}:${where}`);
    }
    return void (await answer());
  }
  if (op === "bx") {
    const r2 = await setReaction(env, chat, item.id, { booked_at: null, booked_on: null, followup_sent: 0 });
    if (clickedId) await restore(env, chat, item, r2, clickedId, where, lang);
    return void (await answer(T.bookCancelled));
  }
  if (op === "rt") {
    // ★ / ✍️ depuis /sorties : la carte de notation de cet item (1–5★ + ✍️ avis).
    await send(env, chat, T.rateIt(label(item, venue?.name)), keyboard(item, prev, lang));
    return void (await answer());
  }
  if (op === "ui") {
    // ✖ depuis /interets : retire ⭐ (et la réservation), sans « ignoré » : l'item
    // revient dans /programme. La liste est rafraîchie sur place.
    const r2 = await setReaction(env, chat, item.id, { interested: 0, booked_at: null, booked_on: null, followup_sent: 0 });
    // ✖ depuis le sélecteur (qui EST le message /sorties : arg « o ») : retour à la liste, à jour.
    // Ancien format (arg = id du message /sorties, sélecteur à part) : on rafraîchit et on retire le sélecteur.
    const legacy = arg && /^\d+$/.test(arg) ? Number(arg) : null;
    const target = legacy ?? clickedId;
    if (target) {
      const o = await outings(env, chat, lang);
      await edit(env, chat, target, o.text, o.kb);
    }
    if (legacy && clickedId) await tg(env, "deleteMessage", { chat_id: chat, message_id: clickedId });
    await refreshMine(env, chat, item, r2, lang);
    ctx.waitUntil(refreshAll(env, item, chat));
    return void (await answer(T.toastNotForMe));
  }
  if (op === "j") {
    // « 🙋 J'y vais aussi » sous une annonce de réservation du groupe.
    if (!prev?.interested) await setReaction(env, chat, item.id, { interested: 1 });
    await send(env, chat, T.joinDm(esc(item.title), whenLabel(decodeWhen(arg), lang), esc(item.url ?? "")));
    ctx.waitUntil(refreshAll(env, item, null));
    return void (await answer(T.toastJoin));
  }

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
        if (!quiet) ctx.waitUntil(announceInterest(env, item, venue?.name, from.first_name, editId));
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
      // Plus d'invitation automatique : la fiche montre [✍️ Critique] (une étape à la fois).
      // Changer sa note ne ré-annonce pas au groupe : seulement la 1re note.
      if (!prev?.rating && !quiet) ctx.waitUntil(announceReview(env, item, venue?.name, chat, from.first_name, n, prev?.comment ?? null));
      break;
    }
    case "w":
      // « ✍️ Écrire / modifier mon avis » : rouvre une invitation pour cet item.
      await askReview(env, chat, item, lang,
        prev?.rating ? T.askComment(stars(prev.rating), esc(item.title)) : T.askReview(esc(item.title)), inGroup ? null : clickedId);
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
    const fromList = /^(🔕 (Ignorés|Ignored)|🙅 (Pas pour moi|Not for me))/.test(cq.message.text ?? "");
    const fromInterests = /^(🗂 (Mes sorties|My outings)|(⭐|🎟) (Ce qui tente|What the gang|Réservations|Bookings))/.test(cq.message.text ?? "");
    if (fromInterests) {
      // ✅ depuis /interets : la ligne disparaît de la liste, la note se donne à part.
      const rows = (cq.message.reply_markup?.inline_keyboard ?? [])
        .filter((row: any[]) => !row.some((b: any) => b.callback_data === data));
      await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: clicked, reply_markup: { inline_keyboard: rows } });
      await send(env, chat, T.rateIt(label(item, venue?.name)), keyboard(item, r, lang));
      if (mine?.message_id) {
        const v = renderFor(item, chat, r, friends, mine.header, lang);
        await edit(env, chat, mine.message_id, v.text, v.reply_markup);
      }
    } else if (fromList) {
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
      await edit(env, chat, clicked, v.text, await cardMarkup(env, chat, clicked, v.reply_markup, lang));
      if (mine?.message_id && mine.message_id !== clicked) {
        const w = renderFor(item, chat, r, friends, mine.header, lang);
        await edit(env, chat, mine.message_id, w.text, w.reply_markup);
      }
    }
  }
  await answer(toast);
  if (socialChanged) ctx.waitUntil(refreshAll(env, item, inGroup ? null : chat));
}

// ---------------------------------------------------------------------------
/** Invitation à laisser un avis : force_reply (Telegram ouvre la réponse à CE
 *  message, avec « Ton avis sur X… » dans le champ) ; message_id -> item. */
async function askReview(env: Env, chat: number, item: Item, lang: Lang, text: string, cardId: number | null = null): Promise<void> {
  const res = await tg(env, "sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { force_reply: true, input_field_placeholder: tr(lang).reviewPlaceholder(item.title).slice(0, 64) },
  });
  const id = res?.result?.message_id;
  if (id) {
    await env.DB.prepare("INSERT OR REPLACE INTO review_prompts (chat_id, message_id, item_id) VALUES (?, ?, ?)")
      .bind(chat, id, item.id).run();
    if (cardId) await setSetting(env, cardKey(chat, id), `${cardId}:c`);
  }
}

/** Invitation (date / avis) -> la fiche d'où elle vient : « 1234:c » (fiche) ou « 1234:o » (/sorties). */
const cardKey = (chat: number, prompt: number) => `prompt_card:${chat}:${prompt}`;

async function promptCard(env: Env, chat: number, prompt: number | null): Promise<{ id: number; where: string } | null> {
  if (!prompt) return null;
  const v = await setting(env, cardKey(chat, prompt));
  if (!v) return null;
  const [id, where] = v.split(":");
  return { id: Number(id), where: where || "c" };
}

/** Une fois la réponse reçue : on retire l'invitation et la réponse (erreurs ignorées : un message
 *  d'utilisateur ne se supprime pas partout). */
async function cleanup(env: Env, chat: number, prompt: number | null, reply: number | null): Promise<void> {
  for (const id of [prompt, reply]) if (id) await tg(env, "deleteMessage", { chat_id: chat, message_id: id });
  if (prompt) await setSetting(env, cardKey(chat, prompt), null);
}

async function onComment(
  env: Env, chat: number, name: string, itemId: string, text: string, ctx: ExecutionContext, lang: Lang,
  promptId: number | null = null, replyId: number | null = null,
): Promise<void> {
  const item = await getItem(env, itemId);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pending_item = NULL WHERE chat_id = ?").bind(chat),
    env.DB.prepare("UPDATE review_prompts SET closed = 1 WHERE chat_id = ? AND item_id = ?").bind(chat, itemId),
  ]);
  if (!item) return;
  const comment = text.slice(0, 500);
  const r = await setReaction(env, chat, item.id, { status: "seen", comment });
  const card = await promptCard(env, chat, promptId);
  if (card) {
    await restore(env, chat, item, r, card.id, "c", lang);   // « ✅ Vu · 4★ · « … » » sur la fiche
    await cleanup(env, chat, promptId, replyId);
  } else {
    await send(env, chat, tr(lang).commentSaved(esc(item.title)));
  }
  const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
  ctx.waitUntil((async () => {
    await announceReview(env, item, venue?.name, chat, name, r.rating, comment);
    await refreshAll(env, item, null);
  })());
}

// ---------------------------------------------------------------------------
// 🎟 Réservations
// ---------------------------------------------------------------------------
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** '2026-12-14 20:00' <-> '202612142000' (callback_data ≤ 64 octets). */
const encodeWhen = (iso: string) => iso.replace(/\D/g, "").slice(0, 12);
const decodeWhen = (s = "") =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` + (s.length >= 12 ? ` ${s.slice(8, 10)}:${s.slice(10, 12)}` : "");

/** « 14/12 », « 14/12 20:00 », « 14.12.2026 20h30 » -> '2026-12-14 20:00' (année : la prochaine occurrence). */
export function parseDate(text: string, today = new Date()): string | null {
  const m = text.trim().match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?(?:\s+(?:à\s+|at\s+)?(\d{1,2})(?:[:hH.](\d{2}))?h?)?$/);
  if (!m) return null;
  const [day, mon] = [Number(m[1]), Number(m[2])];
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : today.getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  let date = `${year}-${pad(mon)}-${pad(day)}`;
  if (!m[3] && date < isoDay(today)) date = `${++year}-${pad(mon)}-${pad(day)}`;
  if (isNaN(new Date(date + "T12:00:00Z").getTime()) || new Date(date + "T12:00:00Z").getUTCDate() !== day) return null;
  if (m[4] === undefined) return date;
  const [h, mi] = [Number(m[4]), Number(m[5] ?? 0)];
  if (h > 23 || mi > 59) return null;
  return `${date} ${pad(h)}:${pad(mi)}`;
}

/** Sélecteur : ~6 prochaines dates connues (pièces/films) ; expos : aujourd'hui / demain / ce week-end. */
function bookPicker(item: Item, r: Reaction | null, lang: Lang, where: "c" | "o" = "c"): unknown {
  const T = tr(lang);
  const sfx = where === "o" ? ":o" : "";
  const rows: { text: string; callback_data: string }[][] = [];
  const today = isoDay(new Date());
  if (item.kind === "expo") {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const sat = new Date(now.getTime() + ((6 - now.getUTCDay() + 7) % 7) * 86400000);
    rows.push([
      { text: T.bookToday, callback_data: `bd:${item.id}:${encodeWhen(isoDay(now))}${sfx}` },
      { text: T.bookTomorrow, callback_data: `bd:${item.id}:${encodeWhen(isoDay(tomorrow))}${sfx}` },
      { text: T.bookWeekend, callback_data: `bd:${item.id}:${encodeWhen(isoDay(sat))}${sfx}` },
    ]);
  } else {
    const dates = [...new Set((JSON.parse(item.dates || "[]") as string[])
      .map((d) => d.replace("T", " ").slice(0, 16)).filter((d) => d.slice(0, 10) >= today))].sort().slice(0, 6);
    for (let i = 0; i < dates.length; i += 2) {
      rows.push(dates.slice(i, i + 2).map((d) => ({ text: whenLabel(d, lang), callback_data: `bd:${item.id}:${encodeWhen(d)}${sfx}` })));
    }
  }
  rows.push([{ text: T.bookOther, callback_data: `bo:${item.id}${sfx}` }]);
  if (r?.booked_at) rows.push([{ text: T.bookCancel, callback_data: `bx:${item.id}${sfx}` }]);
  if (where === "o") {
    rows.push([
      { text: T.btnAlreadySeen, callback_data: `v:${item.id}:o` },
      { text: T.btnRemove, callback_data: `ui:${item.id}:o` },
    ]);
  }
  rows.push([{ text: T.btnBack, callback_data: `bb:${item.id}${sfx}` }]);
  return { inline_keyboard: rows };
}

/** En-tête de la fiche gardé pendant le choix de la date. */
function pickerText(item: Item, venueName: string | undefined, lang: Lang): string {
  return `${label(item, venueName)}\n\n🎟 ${tr(lang).bookWhich}`;
}

/** Remet le message `msgId` en fiche complète (« c ») ou en liste /sorties (« o ») ; ma notif d'origine suit. */
async function restore(env: Env, chat: number, item: Item, r: Reaction | null, msgId: number, where: string, lang: Lang): Promise<void> {
  if (where === "o") {
    const o = await outings(env, chat, lang);
    await edit(env, chat, msgId, o.text, o.kb);
  }
  const mine = await myDelivery(env, chat, item.id);
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  if (where !== "o") {
    const v = renderFor(item, chat, r, friends, mine?.message_id === msgId ? mine.header : null, lang);
    await edit(env, chat, msgId, v.text, await cardMarkup(env, chat, msgId, v.reply_markup, lang));
  }
  if (mine?.message_id && mine.message_id !== msgId) {
    const v = renderFor(item, chat, r, friends, mine.header, lang);
    await edit(env, chat, mine.message_id, v.text, v.reply_markup);
  }
}

/** Remet ma fiche (notif d'origine) à jour : statut « 🎟 Réservé · … ». */
async function refreshMine(env: Env, chat: number, item: Item, r: Reaction, lang: Lang): Promise<void> {
  const mine = await myDelivery(env, chat, item.id);
  if (!mine?.message_id) return;
  const friends = (await friendsByItem(env, [item.id])).get(item.id) ?? [];
  const v = renderFor(item, chat, r, friends, mine.header, lang);
  await edit(env, chat, mine.message_id, v.text, v.reply_markup);
}

/** Réserver = intéressé·e + date ; annonce au groupe avec « 🙋 J'y vais aussi ». */
async function book(
  env: Env, chat: number, who: string, item: Item, iso: string, lang: Lang, ctx: ExecutionContext, quiet = false,
): Promise<Reaction> {
  const r = await setReaction(env, chat, item.id, {
    interested: 1, booked_at: iso, booked_on: new Date().toISOString().slice(0, 19).replace("T", " "), followup_sent: 0,
  });
  ctx.waitUntil((async () => {
    const group = quiet ? null : await groupChat(env);
    if (group) {
      const glang = await grpLang(env);
      const G = tr(glang);
      const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(item.venue_id).first<{ name: string }>();
      const head = G.groupBooked(esc(who), esc(item.title), whenLabel(iso, glang), esc(venue?.name ?? ""));
      const row: any[] = [{ text: G.imIn, callback_data: `j:${item.id}:${encodeWhen(iso)}` }];
      if (item.url) row.push({ text: G.imInLink, url: item.url });
      await send(env, group, card(head, item, glang), { inline_keyboard: [row, [{ text: G.openApp, url: appLink(env, item.id) }]] });
    }
    await refreshAll(env, item, chat);
  })());
  return r;
}

export { socialBlock, type Friend };

/** Critique écrite dans la mini-app : enregistrée sans rien poster (ni au groupe, ni en privé) ;
 *  ma fiche et celles de mes amis se mettent à jour en silence. */
export async function saveReviewFromApp(env: Env, chat: number, itemId: string, text: string, ctx: ExecutionContext): Promise<boolean> {
  const item = await getItem(env, itemId);
  if (!item) return false;
  const u = await env.DB.prepare("SELECT lang FROM users WHERE chat_id = ?").bind(chat).first<{ lang: string | null }>();
  const comment = text.trim().slice(0, 500) || null;
  const r = await setReaction(env, chat, item.id, { status: "seen", comment });
  await env.DB.prepare("UPDATE review_prompts SET closed = 1 WHERE chat_id = ? AND item_id = ?").bind(chat, itemId).run();
  ctx.waitUntil((async () => {
    await refreshMine(env, chat, item, r, asLang(u?.lang));
    await refreshAll(env, item, chat);
  })());
  return true;
}
