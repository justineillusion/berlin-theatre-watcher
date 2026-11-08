// Briques communes : types, accès D1, Telegram, rendu des messages.

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;       // token @BotFather (secret)
  API_TOKEN: string;       // partagé avec le scraper GitHub Actions (secret)
  WEBHOOK_SECRET: string;  // vérifie que les updates viennent bien de Telegram (secret)
  OWNER_CHAT_ID: string;   // ton chat_id : admin du bot
  BOT_USERNAME: string;    // sans @, pour le lien d'invitation
  TG_API?: string;         // tests uniquement (faux Telegram local)
}

export interface Item {
  id: string;
  venue_id: string;
  kind: "theatre" | "expo";
  title: string;
  url: string | null;
  dates: string;           // JSON
  start_date: string | null;
  end_date: string | null;
  starred: number;
  text: string | null;
  line: string | null;
}

export interface Reaction {
  chat_id: number;
  item_id: string;
  interested: number;
  status: "seen" | "ignored" | null;
  rating: number | null;
  comment: string | null;
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

const name = (f: Friend, viewer: number | null) => (f.chat_id === viewer ? "toi" : esc(f.first_name));

/** Bloc « 👥 La bande » : qui est intéressé, qui a vu et ce qu'ils en ont pensé. */
export function socialBlock(friends: Friend[], viewer: number | null, compact = false): string {
  const interested = friends.filter((f) => f.interested && f.status !== "seen" && f.status !== "ignored");
  const seen = friends.filter((f) => f.status === "seen");
  if (!interested.length && !seen.length) return "";

  const rated = seen.filter((f) => f.rating);
  const avg = rated.length ? rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length : 0;

  if (compact) {
    const parts: string[] = [];
    if (interested.length) parts.push(`⭐ ${interested.map((f) => name(f, viewer)).join(", ")}`);
    if (rated.length) parts.push(`✅ ${stars(Math.round(avg))} (${rated.length} avis)`);
    else if (seen.length) parts.push(`✅ vu par ${seen.map((f) => name(f, viewer)).join(", ")}`);
    return `   👥 ${parts.join(" · ")}`;
  }

  const lines = ["\n👥 <b>La bande</b>"];
  if (interested.length) {
    lines.push(`⭐ Intéressé·es : ${interested.map((f) => name(f, viewer)).join(", ")}`);
  }
  if (seen.length) {
    if (rated.length > 1) {
      lines.push(`✅ Note moyenne : ${stars(Math.round(avg))} ${avg.toFixed(1).replace(".", ",")}/5 (${rated.length} avis)`);
    }
    for (const f of seen.slice(-6)) {
      const note = f.rating ? ` ${stars(f.rating)}` : "";
      const word = f.comment ? ` — « ${esc(f.comment.slice(0, 140))} »` : "";
      lines.push(`✅ ${name(f, viewer)}${note}${word}`);
    }
  }
  return lines.join("\n");
}

/** Boutons sous une notif, selon l'état de la personne qui la regarde. */
export function keyboard(item: Item, r: Reaction | null): unknown {
  const id = item.id;
  if (r?.status === "ignored") {
    return { inline_keyboard: [[{ text: "↩️ Ne plus ignorer", callback_data: `u:${id}` }]] };
  }
  if (r?.status === "seen") {
    const row = [1, 2, 3, 4, 5].map((n) => ({
      text: r.rating === n ? `· ${n}★ ·` : `${n}★`,
      callback_data: `r:${id}:${n}`,
    }));
    return { inline_keyboard: [row, [{ text: "↩️ Pas vu finalement", callback_data: `u:${id}` }]] };
  }
  const verb = item.kind === "expo" ? "Vue" : "Vu";
  return {
    inline_keyboard: [[
      { text: r?.interested ? "⭐ Intéressé·e ✓" : "⭐ Intéressé·e", callback_data: `i:${id}` },
      { text: `✅ ${verb}`, callback_data: `v:${id}` },
      { text: "🔕 Ignorer", callback_data: `x:${id}` },
    ]],
  };
}

function statusLine(item: Item, r: Reaction | null): string {
  const what = item.kind === "expo" ? "cette expo" : "cette pièce";
  if (r?.status === "ignored") return `\n🔕 <i>Ignoré : plus aucune notif sur ${what}, même si elle revient.</i>`;
  if (r?.status === "seen") {
    return r.rating
      ? `\n✅ <i>Ta note : ${stars(r.rating)}${r.comment ? ` — « ${esc(r.comment.slice(0, 140))} »` : ""}</i>`
      : `\n✅ <i>Noté comme ${item.kind === "expo" ? "vue" : "vu"} — plus de notif. Une note pour la bande ?</i>`;
  }
  return "";
}

const MAX = 4000;

/** Message complet pour une personne : en-tête + corps + bande + état. */
export function renderFor(
  item: Item, viewer: number, r: Reaction | null, friends: Friend[], header: string | null,
): { text: string; reply_markup: unknown } {
  const body = item.text || `<b>${esc(item.title)}</b>`;
  const tail = socialBlock(friends, viewer) + statusLine(item, r);
  let text = (header ? `${header}\n` : "") + body;
  if (text.length + tail.length > MAX) text = text.slice(0, MAX - tail.length - 1) + "…";
  return { text: text + tail, reply_markup: keyboard(item, r) };
}
