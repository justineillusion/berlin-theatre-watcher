// API appelée par le scraper (GitHub Actions) : qui reçoit quoi.
//
//   POST /api/plan    lieux + pièces (sans texte) -> ids à rédiger
//   POST /api/render  textes                     -> messages prêts à envoyer
//   POST /api/sent    accusés d'envoi            -> mémorise dates + message_id
//   POST /api/cinema-recipients  cinémas        -> qui suit quels cinémas (ciné du dimanche)
//   POST /api/cinema-done        semaine        -> récap envoyé (idempotence des 2 crons)
import { Lang, asLang, tr } from "./i18n";
import {
  Env, Item, Reaction, esc, frDate, friendsByItem, itemLine, renderFor, setSetting, setting, socialBlock,
} from "./lib";

interface MetaIn {
  id: string; venue_id: string; kind: "theatre" | "expo"; title: string; url: string | null;
  dates: string[]; start_date: string | null; end_date: string | null; starred: boolean;
}

interface Pending {
  chat_id: number;
  item_id: string;
  kind: "new" | "new_dates" | "last_weeks";
  dates: string[];        // toutes les dates actuelles (à mémoriser)
  fresh: string[];        // dates inédites pour cette personne
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** Le cœur : pour chaque item × ami abonné, faut-il envoyer quelque chose ? */
async function computePending(
  env: Env, ids: string[], lastWeeksDays: number, prime: boolean,
): Promise<Pending[]> {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const [items, subs, reactions, deliveries] = await Promise.all([
    env.DB.prepare("SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))").bind(json).all<Item>(),
    env.DB.prepare(
      `SELECT s.chat_id, s.venue_id, s.primed FROM subscriptions s
       JOIN users u ON u.chat_id = s.chat_id WHERE u.active = 1`,
    ).all<{ chat_id: number; venue_id: string; primed: number }>(),
    env.DB.prepare("SELECT * FROM reactions WHERE item_id IN (SELECT value FROM json_each(?))").bind(json).all<Reaction>(),
    env.DB.prepare(
      "SELECT chat_id, item_id, dates, reminded FROM deliveries WHERE item_id IN (SELECT value FROM json_each(?))",
    ).bind(json).all<{ chat_id: number; item_id: string; dates: string; reminded: number }>(),
  ]);

  const react = new Map(reactions.results.map((r) => [`${r.chat_id}|${r.item_id}`, r]));
  const deliv = new Map(deliveries.results.map((d) => [`${d.chat_id}|${d.item_id}`, d]));
  const subsByVenue = new Map<string, { chat_id: number; primed: number }[]>();
  for (const s of subs.results) {
    if (!subsByVenue.has(s.venue_id)) subsByVenue.set(s.venue_id, []);
    subsByVenue.get(s.venue_id)!.push(s);
  }

  const out: Pending[] = [];
  const silent: D1PreparedStatement[] = [];
  const primedSubs = new Set<string>();
  const now = today();

  for (const item of items.results) {
    const dates: string[] = JSON.parse(item.dates || "[]");
    for (const sub of subsByVenue.get(item.venue_id) ?? []) {
      const key = `${sub.chat_id}|${item.id}`;
      const r = react.get(key);
      if (r?.status === "seen" || r?.status === "ignored") continue;   // ✅ / 🔕 : silence
      const d = deliv.get(key);

      if (!sub.primed) {
        // Abonnement neuf : on enregistre le catalogue existant SANS envoyer.
        if (prime && !d) {
          silent.push(env.DB.prepare(
            "INSERT OR IGNORE INTO deliveries (chat_id, item_id, dates, message_id) VALUES (?, ?, ?, NULL)",
          ).bind(sub.chat_id, item.id, JSON.stringify(dates)));
        }
        primedSubs.add(`${sub.chat_id}|${item.venue_id}`);
        continue;
      }

      if (!d) {
        out.push({ chat_id: sub.chat_id, item_id: item.id, kind: "new", dates, fresh: [] });
        continue;
      }
      if (item.kind === "theatre") {
        const known = new Set<string>(JSON.parse(d.dates || "[]"));
        const fresh = dates.filter((x) => !known.has(x)).sort();
        if (fresh.length) out.push({ chat_id: sub.chat_id, item_id: item.id, kind: "new_dates", dates, fresh });
      } else if (
        r?.interested && !d.reminded && item.end_date &&
        item.end_date >= now && item.end_date <= addDays(now, lastWeeksDays)
      ) {
        out.push({ chat_id: sub.chat_id, item_id: item.id, kind: "last_weeks", dates, fresh: [] });
      }
    }
  }

  if (prime && primedSubs.size) {
    for (const k of primedSubs) {
      const [chat, venue] = k.split("|");
      silent.push(env.DB.prepare("UPDATE subscriptions SET primed = 1 WHERE chat_id = ? AND venue_id = ?")
        .bind(Number(chat), venue));
    }
  }
  if (silent.length) await env.DB.batch(silent);
  return out;
}

function header(p: Pending, item: Item, lang: Lang): string | null {
  const T = tr(lang);
  if (p.kind === "new_dates") {
    const shown = p.fresh.slice(0, 6).map((d) => frDate(d)).join(", ");
    const more = p.fresh.length > 6 ? ` (+${p.fresh.length - 6})` : "";
    return T.newDates(shown + more);
  }
  if (p.kind === "last_weeks") return T.lastWeeks(frDate(item.end_date));
  return null;
}

// ---------------------------------------------------------------------------
// Lieux
// ---------------------------------------------------------------------------
interface VenueIn { id: string; name: string; kind: string }

/** Enregistre les lieux d'un job. `scope` (SQL) = les lieux dont CE job est
 *  responsable : seuls ceux-là sont désactivés s'ils ont disparu de sa config
 *  (le scan théâtre ne touche pas aux cinémas, et inversement). */
async function upsertVenues(env: Env, venues: VenueIn[], scope: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE venues SET active = 0 WHERE ${scope}`),
    ...venues.map((v, i) => env.DB.prepare(
      `INSERT INTO venues (id, name, kind, position, active) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         position = excluded.position, active = 1`,
    ).bind(v.id, v.name, v.kind, i)),
  ];
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));

  // Les nouveaux lieux sont proposés… mais pas imposés : un ami qui suivait
  // déjà tout est abonné d'office (en silence), les autres choisiront via /suivre.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions (chat_id, venue_id, primed)
     SELECT u.chat_id, v.id, 0 FROM users u, venues v
     WHERE u.active = 1 AND v.active = 1
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'known_venue:' || v.id)
       AND (SELECT COUNT(*) FROM subscriptions s WHERE s.chat_id = u.chat_id)
         >= (SELECT COUNT(*) FROM settings WHERE key LIKE 'known_venue:%')`,
  ).run();
  if (venues.length) {
    await env.DB.batch(venues.map((v) => env.DB.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES ('known_venue:' || ?, '1')").bind(v.id)));
  }
}

/** Le récap ciné de la semaine `week` est parti (voir cinemaRecipients). */
export async function cinemaDone(env: Env, body: any): Promise<Response> {
  if (typeof body.week !== "string") return Response.json({ ok: false }, { status: 400 });
  await setSetting(env, "cinema_week", body.week);
  return Response.json({ ok: true });
}

/** Ciné du dimanche : enregistre les cinémas de cinema.yaml, puis dit qui suit
 *  quels cinémas (amis actifs suivant au moins un cinéma actif). */
export async function cinemaRecipients(env: Env, body: any): Promise<Response> {
  const venues: VenueIn[] = (body.venues ?? [])
    .filter((v: any) => v && typeof v.id === "string" && typeof v.name === "string")
    .map((v: any) => ({ id: v.id, name: v.name, kind: "cinema" }));
  // Liste vide = config illisible : on ne désactive rien, on ne vise personne.
  if (!venues.length) return Response.json({ recipients: [] });
  await upsertVenues(env, venues, "kind = 'cinema'");
  // Deux créneaux cron le dimanche (GitHub en saute parfois un) : le second
  // ne renvoie rien si le récap de cette semaine est déjà parti.
  const week = typeof body.week === "string" ? body.week : null;
  if (week && !body.force && (await setting(env, "cinema_week")) === week) {
    return Response.json({ recipients: [], already_sent: true });
  }
  const { results } = await env.DB.prepare(
    `SELECT s.chat_id, COALESCE(u.lang, 'fr') AS lang, json_group_array(s.venue_id) AS venue_ids FROM subscriptions s
     JOIN users u ON u.chat_id = s.chat_id AND u.active = 1
     JOIN venues v ON v.id = s.venue_id AND v.active = 1 AND v.kind = 'cinema'
     GROUP BY s.chat_id ORDER BY s.chat_id`,
  ).all<{ chat_id: number; lang: string; venue_ids: string }>();
  return Response.json({
    recipients: results.map((r) => ({ chat_id: r.chat_id, lang: asLang(r.lang), venue_ids: JSON.parse(r.venue_ids) })),
  });
}

// ---------------------------------------------------------------------------
export async function plan(env: Env, body: any): Promise<Response> {
  const mode: "scan" | "digest" = body.mode === "digest" ? "digest" : "scan";
  const venues: { id: string; name: string; kind: string }[] = body.venues ?? [];
  const items: MetaIn[] = body.items ?? [];
  const started = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Les cinémas (kind = 'cinema') sont enregistrés par le job ciné : ce scan-ci
  // ne désactive que les théâtres / lieux d'expo absents de config.yaml.
  await upsertVenues(env, venues, "kind != 'cinema'");
  const stmts: D1PreparedStatement[] = items.map((it) => env.DB.prepare(
      `INSERT INTO items (id, venue_id, kind, title, url, dates, start_date, end_date, starred, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET venue_id = excluded.venue_id, kind = excluded.kind,
         title = excluded.title, url = excluded.url, dates = excluded.dates,
         start_date = excluded.start_date, end_date = excluded.end_date,
         starred = excluded.starred, last_seen = excluded.last_seen`,
    ).bind(it.id, it.venue_id, it.kind, it.title, it.url, JSON.stringify(it.dates ?? []),
      it.start_date, it.end_date, it.starred ? 1 : 0, started));
  // D1 : pas plus de ~100 requêtes par batch, on découpe.
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));

  const ids = items.map((i) => i.id);
  await setSetting(env, "current_since", started);
  await setSetting(env, "expo_last_weeks_days", String(Number(body.expo_last_weeks_days ?? 14)));

  const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1").first<{ n: number }>();
  // Langues à rédiger : le scraper ne produit la variante anglaise que si quelqu'un la lit.
  const { results: langRows } = await env.DB.prepare(
    "SELECT DISTINCT COALESCE(lang, 'fr') AS lang FROM users WHERE active = 1").all<{ lang: string }>();
  const langs = [...new Set(["fr", ...langRows.map((r) => asLang(r.lang))])];
  if (mode === "digest") return Response.json({ need: ids, users: users?.n ?? 0, langs });

  const pending = await computePending(env, ids, Number(body.expo_last_weeks_days ?? 14), true);
  return Response.json({ need: [...new Set(pending.map((p) => p.item_id))], users: users?.n ?? 0, langs });
}

// ---------------------------------------------------------------------------
export async function render(env: Env, body: any): Promise<Response> {
  const mode = body.mode === "digest" ? "digest" : "scan";
  const texts: { id: string; text: string; line: string; text_en?: string; line_en?: string }[] = body.items ?? [];
  const stmts = texts.map((t) =>
    env.DB.prepare("UPDATE items SET text = ?, line = ?, text_en = ?, line_en = ? WHERE id = ?")
      .bind(t.text, t.line, t.text_en ?? null, t.line_en ?? null, t.id));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  const ids = texts.map((t) => t.id);

  if (mode === "digest") {
    const users = await env.DB.prepare("SELECT chat_id, lang FROM users WHERE active = 1").all<{ chat_id: number; lang: string }>();
    const messages: unknown[] = [];
    for (const u of users.results) {
      const lang = asLang(u.lang);
      for (const text of await digestFor(env, u.chat_id, ids, tr(lang).sundayDigest, lang)) {
        messages.push({ chat_id: u.chat_id, kind: "digest", text });
      }
    }
    return Response.json({ messages });
  }

  const days = Number(await setting(env, "expo_last_weeks_days") ?? 14);
  const pending = await computePending(env, ids, days, false);
  const itemIds = [...new Set(pending.map((p) => p.item_id))];
  const { results: items } = await env.DB.prepare(
    "SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(itemIds)).all<Item>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const friends = await friendsByItem(env, itemIds);
  const { results: reacts } = await env.DB.prepare(
    "SELECT * FROM reactions WHERE item_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(itemIds)).all<Reaction>();
  const react = new Map(reacts.map((r) => [`${r.chat_id}|${r.item_id}`, r]));
  const { results: langRows } = await env.DB.prepare("SELECT chat_id, lang FROM users").all<{ chat_id: number; lang: string }>();
  const langOf = new Map(langRows.map((u) => [u.chat_id, asLang(u.lang)]));

  // Ordre : ⭐ (mots-clés) d'abord, puis par date.
  pending.sort((a, b) => {
    const A = byId.get(a.item_id)!, B = byId.get(b.item_id)!;
    return (B.starred - A.starred) || String(A.start_date ?? a.dates[0] ?? "").localeCompare(String(B.start_date ?? b.dates[0] ?? ""));
  });

  const messages = pending.map((p) => {
    const item = byId.get(p.item_id)!;
    const lang = langOf.get(p.chat_id) ?? "fr";
    const h = header(p, item, lang);
    const { text, reply_markup } = renderFor(item, p.chat_id, react.get(`${p.chat_id}|${p.item_id}`) ?? null,
      friends.get(p.item_id) ?? [], h, lang);
    return { chat_id: p.chat_id, item_id: p.item_id, kind: p.kind, dates: p.dates, header: h, text, reply_markup };
  });
  return Response.json({ messages });
}

// ---------------------------------------------------------------------------
export async function sent(env: Env, body: any): Promise<Response> {
  const stmts: D1PreparedStatement[] = [];
  for (const s of body.sent ?? []) {
    if (s.error === 403) {
      stmts.push(env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?").bind(s.chat_id));
      continue;
    }
    if (!s.item_id || s.kind === "digest") continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO deliveries (chat_id, item_id, dates, message_id, header, reminded, sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
       ON CONFLICT(chat_id, item_id) DO UPDATE SET
         dates = (SELECT json_group_array(value) FROM (
                    SELECT value FROM json_each(deliveries.dates)
                    UNION SELECT value FROM json_each(?3))),
         message_id = ?4, header = ?5,
         reminded = MAX(deliveries.reminded, ?6), sent_at = datetime('now')`,
    ).bind(s.chat_id, s.item_id, JSON.stringify(s.dates ?? []), s.message_id ?? null,
      s.header ?? null, s.kind === "last_weeks" ? 1 : 0));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return Response.json({ ok: true, recorded: stmts.length });
}

// ---------------------------------------------------------------------------
// Récap (dimanche, ou /programme à la demande)
// ---------------------------------------------------------------------------
export async function digestFor(
  env: Env, chat_id: number, ids: string[] | null, title: string, lang: Lang = "fr",
): Promise<string[]> {
  const T = tr(lang);
  const since = await setting(env, "current_since");
  const horizon = addDays(today(), 45);   // expos : ouvertes, ou qui ouvrent sous 6 semaines
  const { results } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue_name, v.position FROM items i
     JOIN venues v ON v.id = i.venue_id AND v.active = 1
     JOIN subscriptions s ON s.venue_id = i.venue_id AND s.chat_id = ?1
     LEFT JOIN reactions r ON r.item_id = i.id AND r.chat_id = ?1
     WHERE (r.status IS NULL)
       AND i.line IS NOT NULL
       AND (?2 IS NULL OR i.id IN (SELECT value FROM json_each(?2)))
       AND (?2 IS NOT NULL OR i.last_seen >= ?3)
       AND (i.kind = 'theatre' OR i.start_date IS NULL OR i.start_date = '' OR i.start_date <= ?4)
     ORDER BY i.kind DESC, v.position, COALESCE(NULLIF(i.start_date, ''), json_extract(i.dates, '$[0]'), '9999')`,
  ).bind(chat_id, ids ? JSON.stringify(ids) : null, since ?? "", horizon).all<Item & { venue_name: string }>();

  if (!results.length) {
    return [`${title}\n\n${T.digestEmpty}`];
  }
  const friends = await friendsByItem(env, results.map((r) => r.id));
  const nTheatre = results.filter((r) => r.kind === "theatre").length;
  const nExpo = results.length - nTheatre;
  const counts = [nTheatre && T.plays(nTheatre), nExpo && T.expos(nExpo)]
    .filter(Boolean).join(" · ");

  const blocks: string[] = [];
  let section = "", venue = "";
  for (const it of results) {
    if (it.kind !== section) {
      section = it.kind;
      blocks.push(section === "theatre" ? T.theatreSection : T.expoSection);
      venue = "";
    }
    if (it.venue_name !== venue) {
      venue = it.venue_name;
      blocks.push(`\n📍 <b>${esc(venue)}</b>`);
    }
    const social = socialBlock(friends.get(it.id) ?? [], chat_id, true, lang);
    blocks.push(itemLine(it, lang)! + (social ? `\n${social}` : ""));
  }

  const messages: string[] = [];
  let cur = `${title} — ${counts}\n${T.legend}`;
  for (const b of blocks) {
    if (cur.length + b.length + 1 > 3500) { messages.push(cur); cur = b.replace(/^\n/, ""); }
    else cur += "\n" + b;
  }
  messages.push(cur);
  return messages;
}
