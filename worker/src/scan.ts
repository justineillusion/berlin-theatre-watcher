// API appelée par le scraper (GitHub Actions) : qui reçoit quoi.
//
//   POST /api/plan    lieux + pièces (sans texte) -> ids à rédiger
//   POST /api/render  textes                     -> messages prêts à envoyer
//   POST /api/sent    accusés d'envoi            -> mémorise dates + message_id
//   POST /api/cinema-recipients  cinémas        -> qui suit quels cinémas (ciné du dimanche)
//   POST /api/cinema-done        semaine        -> récap envoyé (idempotence des 2 crons)
import { Lang, asLang, tr } from "./i18n";
import { groupInterests } from "./group";
import { berlinNow } from "./sales";
import {
  Env, Horizon, Item, Reaction, esc, frDate, friendsByItem, horizon, inWindow, itemLine, itemText, renderFor, setSetting, setting,
  socialBlock, visibleTo, windowEnd, windowSql,
} from "./lib";

interface MetaIn {
  id: string; venue_id: string; kind: "theatre" | "expo"; title: string; url: string | null;
  dates: string[]; start_date: string | null; end_date: string | null; starred: boolean;
}

interface Pending {
  chat_id: number;
  item_id: string;
  kind: "new" | "new_dates" | "last_weeks" | "star_dates";
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
    // Un lieu inactif (retiré de la config) ne produit JAMAIS de message.
    env.DB.prepare(
      `SELECT i.* FROM items i JOIN venues v ON v.id = i.venue_id AND v.active = 1
       WHERE i.id IN (SELECT value FROM json_each(?))`).bind(json).all<Item>(),
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
  const h = await horizon(env);

  for (const item of items.results) {
    const dates: string[] = JSON.parse(item.dates || "[]");
    for (const sub of subsByVenue.get(item.venue_id) ?? []) {
      const key = `${sub.chat_id}|${item.id}`;
      const r = react.get(key);
      if (r?.status === "seen" || r?.status === "ignored") continue;   // ✅ / 🔕 : silence
      // ⭐ : déjà dans /interets — on ne le repropose pas (ni « nouveau », ni
      // nouvelles dates). Seule exception : le rappel « dernières semaines » d'une expo.
      const wanted = !!r?.interested;
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

      // Hors fenêtre (pièce sans date sous `h.theatre` jours, expo qui ouvre dans
      // plus de `h.expo` jours) : rien pour l'instant ; annoncé UNE fois quand
      // l'item entre dans la fenêtre (pas encore de livraison = « nouveau »).
      const win = item.kind === "theatre" ? inWindow(dates, h) : dates;
      if (!d) {
        if (wanted) continue;
        if (item.kind === "theatre" && !win.length) continue;
        if (item.kind === "expo" && item.start_date && item.start_date > windowEnd(h.expo)) continue;
        out.push({ chat_id: sub.chat_id, item_id: item.id, kind: "new", dates, fresh: [] });
        continue;
      }
      if (item.kind === "theatre") {
        // ⭐ qui reçoit des dates = réserver maintenant : « star_dates », envoyé tout de suite.
        const known = new Set<string>(JSON.parse(d.dates || "[]"));
        // Dates vraiment nouvelles ET dans la fenêtre ; celles d'après attendront
        // (non mémorisées, elles seront annoncées en y entrant).
        const fresh = win.filter((x) => !known.has(x));
        if (fresh.length) {
          out.push({ chat_id: sub.chat_id, item_id: item.id, kind: wanted ? "star_dates" : "new_dates", dates: [...known, ...fresh], fresh });
        }
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

/** Films du récap ciné -> items (kind 'film') : ⭐ ✅ 🔕 comme une pièce. */
/** Remet le bloc 📝 de l'ancien texte dans le nouveau s'il n'en a pas (avant les liens 🎟/🔗). */
export function keepSynopsis(next: string | null, prev: string | null | undefined): string | null {
  if (!next || next.includes("📝") || !prev) return next;
  // Bloc replié (« <blockquote expandable>📝 … </blockquote> ») ou ancien format (📝 jusqu'à la ligne vide).
  const m = prev.match(/\n\n(?:<blockquote expandable>📝[\s\S]*?<\/blockquote>|📝[^\n]*(?:\n(?!\n)[^\n]*)*)/u);
  if (!m) return next;
  const at = next.search(/\n\n(?:🎟|🔗)/u);
  return at >= 0 ? next.slice(0, at) + m[0] + next.slice(at) : next + m[0];
}

async function upsertFilms(env: Env, list: any[]): Promise<void> {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { results: oldRows } = await env.DB.prepare(
    "SELECT id, text, text_en FROM items WHERE id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(list.map((f) => f.id))).all<{ id: string; text: string | null; text_en: string | null }>();
  const old = new Map(oldRows.map((r) => [r.id, r]));
  for (const f of list) {
    f.text = keepSynopsis(f.text ?? null, old.get(f.id)?.text);
    f.text_en = keepSynopsis(f.text_en ?? null, old.get(f.id)?.text_en);
  }
  const stmts = list.map((f) => env.DB.prepare(
    `INSERT INTO items (id, venue_id, kind, title, url, dates, starred, text, line, text_en, line_en, last_seen)
     VALUES (?, ?, 'film', ?, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET venue_id = excluded.venue_id, kind = 'film', title = excluded.title,
       url = excluded.url, dates = excluded.dates, text = excluded.text, line = excluded.line,
       text_en = excluded.text_en, line_en = excluded.line_en, last_seen = excluded.last_seen`,
  ).bind(f.id, f.venue_id, f.title, f.url ?? null, JSON.stringify(f.dates ?? []), f.text ?? null, f.line ?? null,
    f.text_en ?? null, f.line_en ?? null, now));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

/** Ciné du dimanche, un message par film :
 *    films   : les films retenus (fiches fr/en, séances = dates)
 *    targets : [{chat_id, ids}] — la sélection de chacun (selon SES cinémas), faite par le scraper
 *  -> messages prêts à envoyer (⭐ ✅ 🔕, ligne 👥). Pas de renvoi d'un film déjà reçu sauf
 *     nouvelles séances ; jamais s'il est vu ou ignoré. Accusés via /api/sent, comme les pièces. */
export async function filmPlan(env: Env, body: any): Promise<Response> {
  const list: any[] = (body.films ?? []).filter((f: any) => f && typeof f.id === "string" && f.title);
  await upsertFilms(env, list);
  // `cards` : fiche + dates propres à chaque ami (séances des seuls cinémas qu'il suit).
  const targets: { chat_id: number; ids: string[]; cards?: Record<string, Partial<Item> & { dates?: string[] }> }[] =
    body.targets ?? [];
  const ids = [...new Set(targets.flatMap((t) => t.ids))];
  if (!ids.length) return Response.json({ messages: [] });
  const json = JSON.stringify(ids);
  const [items, reactions, deliveries, users] = await Promise.all([
    env.DB.prepare("SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))").bind(json).all<Item>(),
    env.DB.prepare("SELECT * FROM reactions WHERE item_id IN (SELECT value FROM json_each(?))").bind(json).all<Reaction>(),
    env.DB.prepare("SELECT chat_id, item_id, dates FROM deliveries WHERE item_id IN (SELECT value FROM json_each(?))")
      .bind(json).all<{ chat_id: number; item_id: string; dates: string }>(),
    env.DB.prepare("SELECT chat_id, lang FROM users WHERE active = 1").all<{ chat_id: number; lang: string }>(),
  ]);
  const byId = new Map(items.results.map((i) => [i.id, i]));
  const react = new Map(reactions.results.map((r) => [`${r.chat_id}|${r.item_id}`, r]));
  const deliv = new Map(deliveries.results.map((d) => [`${d.chat_id}|${d.item_id}`, d]));
  const langOf = new Map(users.results.map((u) => [u.chat_id, asLang(u.lang)]));
  const friends = await friendsByItem(env, ids);

  const messages: unknown[] = [];
  for (const t of targets) {
    const lang = langOf.get(t.chat_id);
    if (!lang) continue;                                   // inactif / inconnu
    for (const id of t.ids) {
      const base = byId.get(id);
      if (!base) continue;
      const own = t.cards?.[id];
      const item: Item = own
        ? { ...base, text: own.text ?? base.text, line: own.line ?? base.line,
            text_en: own.text_en ?? base.text_en, line_en: own.line_en ?? base.line_en,
            dates: own.dates ? JSON.stringify(own.dates) : base.dates }
        : base;
      const key = `${t.chat_id}|${id}`;
      const r = react.get(key) ?? null;
      if (r?.status === "seen" || r?.status === "ignored" || r?.interested) continue;   // vu / ignoré / ⭐ déjà noté
      const dates: string[] = JSON.parse(item.dates || "[]");
      const d = deliv.get(key);
      let kind: "new" | "new_dates" = "new";
      let h: string | null = null;
      if (d) {
        const known = new Set<string>(JSON.parse(d.dates || "[]"));
        const fresh = dates.filter((x) => !known.has(x)).sort();
        if (!fresh.length) continue;                       // déjà reçu, rien de neuf
        kind = "new_dates";
        const shown = fresh.slice(0, 6).map((x) => `${frDate(x)} ${x.slice(11, 16)}`.trim()).join(", ");
        h = tr(lang).newSessions(shown + (fresh.length > 6 ? ` (+${fresh.length - 6})` : ""));
      }
      const v = renderFor(item, t.chat_id, r, friends.get(id) ?? [], h, lang);
      messages.push({ chat_id: t.chat_id, item_id: id, kind, dates, header: h, text: v.text, reply_markup: v.reply_markup,
        body: itemText(item, lang) });
    }
  }
  // Dimanche (Berlin), envoi demandé en file : les fiches partent avec le récap de 9:00
  // (daily.ts), juste après son en-tête. Sinon (autre jour, tests) : renvoyées pour envoi direct.
  // Après midi, le récap est parti sans les films : envoi direct, comme avant.
  const now = body.now ? new Date(body.now) : new Date();            // `now` : tests
  const queue = body.queue && berlinNow(now).day === sundayOf(now) && berlinNow(now).hm < "12:00" &&
    (await setting(env, "immediate_cards")) !== "1";
  if (queue) {
    const stmts = (messages as any[]).map((m) => env.DB.prepare(
      `INSERT INTO film_queue (chat_id, item_id, kind, header, dates, text, markup) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, item_id) DO UPDATE SET kind = excluded.kind, header = excluded.header, dates = excluded.dates,
         text = excluded.text, markup = excluded.markup, queued_at = datetime('now'), sent_at = NULL`,
    ).bind(m.chat_id, m.item_id, m.kind, m.header, JSON.stringify(m.dates), m.body ?? m.text, JSON.stringify(m.reply_markup)));
    for (const t of targets as any[]) {
      if (typeof t.header === "string" && (messages as any[]).some((m) => m.chat_id === t.chat_id)) {
        stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
          .bind(`film_header:${t.chat_id}`, t.header));
      }
    }
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
    await setSetting(env, "film_plan_day", berlinNow(now).day);
    return Response.json({ messages: [], queued: messages.length });
  }
  for (const m of messages as any[]) delete m.body;
  return Response.json({ messages });
}

/** « 2026-11-08 » si aujourd'hui (Berlin) est un dimanche, sinon « ». */
export function sundayOf(now: Date): string {
  const day = berlinNow(now).day;
  return new Date(day + "T12:00:00Z").getUTCDay() === 0 ? day : "";
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
  // Un lieu sauté ce coup-ci (site lent / en panne → rien reçu de lui) garde
  // son dernier programme connu, au lieu de disparaître de /programme.
  const prevSince = await setting(env, "current_since");
  const seenVenues = [...new Set(items.map((i) => i.venue_id))];
  if (prevSince) {
    await env.DB.prepare(
      `UPDATE items SET last_seen = ?1
       WHERE last_seen >= ?2 AND last_seen < ?1 AND kind IN ('theatre', 'expo')
         AND venue_id IN (SELECT id FROM venues WHERE active = 1 AND kind != 'cinema')
         AND venue_id NOT IN (SELECT value FROM json_each(?3))
         AND (CASE WHEN kind = 'expo' THEN end_date IS NULL OR end_date = '' OR end_date >= date('now')
                   ELSE (SELECT MAX(value) FROM json_each(dates)) >= date('now') END)`,
    ).bind(started, prevSince, JSON.stringify(seenVenues)).run();
  }
  await setSetting(env, "current_since", started);
  await setSetting(env, "expo_last_weeks_days", String(Number(body.expo_last_weeks_days ?? 14)));
  if (body.horizon_expo_days != null) await setSetting(env, "horizon_expo_days", String(Number(body.horizon_expo_days)));
  if (body.horizon_theatre_days != null) await setSetting(env, "horizon_theatre_days", String(Number(body.horizon_theatre_days)));
  // Calendrier des ventes (src/sales.py) : fusionné par lieu, lu par les crons du Worker.
  if (body.sales && typeof body.sales === "object" && Object.keys(body.sales).length) {
    const cur = JSON.parse((await setting(env, "sales")) ?? "{}");
    await setSetting(env, "sales", JSON.stringify({ ...cur, ...body.sales }));
  }

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
  // `basic` : version courte (sans résumé ni critiques) de TOUT le catalogue, pour
  // /programme et les récaps ; n'écrase jamais un texte complet déjà rédigé.
  const basic: { id: string; text: string; line: string; text_en?: string; line_en?: string }[] = body.basic ?? [];
  const { results: oldRows } = await env.DB.prepare(
    "SELECT id, text, text_en FROM items WHERE id IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(texts.map((t) => t.id))).all<{ id: string; text: string | null; text_en: string | null }>();
  const old = new Map(oldRows.map((r) => [r.id, r]));
  const stmts = [
    ...basic.map((t) => env.DB.prepare(
      `UPDATE items SET text = COALESCE(text, ?), line = COALESCE(line, ?),
         text_en = COALESCE(text_en, ?), line_en = COALESCE(line_en, ?) WHERE id = ?`,
    ).bind(t.text, t.line, t.text_en ?? null, t.line_en ?? null, t.id)),
    // Un texte SANS 📝 ne fait jamais perdre un 📝 déjà en base (résumé pas fini
    // à temps ce scan-ci, traduction ratée…) : on y remet l'ancien 📝, par langue,
    // en gardant tout le reste à jour (dates, notes…).
    ...texts.map((t) => {
      const o = old.get(t.id);
      return env.DB.prepare("UPDATE items SET text = ?, line = ?, text_en = ?, line_en = COALESCE(?, line_en) WHERE id = ?")
        .bind(keepSynopsis(t.text, o?.text), t.line, keepSynopsis(t.text_en ?? null, o?.text_en) ?? o?.text_en ?? null,
          t.line_en ?? null, t.id);
    }),
  ];
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  const ids = texts.map((t) => t.id);

  if (mode === "digest") {
    const users = await env.DB.prepare("SELECT chat_id, lang FROM users WHERE active = 1").all<{ chat_id: number; lang: string }>();
    const messages: unknown[] = [];
    // Le récap par personne est désormais celui du dimanche 9:00 (daily.ts) ; l'ancien ne part
    // plus qu'en mode « immediate_cards » (tests). Le groupe garde son récap hebdo.
    const legacy = (await setting(env, "immediate_cards")) === "1";
    for (const u of legacy ? users.results : []) {
      const lang = asLang(u.lang);
      for (const text of await digestFor(env, u.chat_id, ids, tr(lang).sundayDigest, lang)) {
        messages.push({ chat_id: u.chat_id, kind: "digest", text });
      }
    }
    // Le groupe : ce qui tente au moins un membre (dates à venir, expos qui ferment).
    const group = await setting(env, "group_chat_id");
    if (group) {
      const glang = asLang(await setting(env, "group_lang"));
      for (const text of await groupInterests(env, glang, tr(glang).weeklyGroupTitle)) {
        messages.push({ chat_id: Number(group), kind: "digest", text });
      }
    }
    return Response.json({ messages });
  }

  const days = Number(await setting(env, "expo_last_weeks_days") ?? 14);
  let pending = await computePending(env, ids, days, false);
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

  // Urgent, hors lot : nouvelles dates d'une ⭐ (toujours), et toutes les nouvelles dates d'un lieu
  // le jour de son ouverture des ventes (de l'heure d'ouverture à minuit). Un message compact par
  // personne, une ligne par pièce avec son lien 🎟 ; livraison notée ici (dates connues).
  const urgent = await urgentDates(env, pending, byId, langOf);
  pending = pending.filter((p) => !urgent.taken.has(p));
  // Lot du matin (daily.ts) : les fiches attendent ~9:00 (Berlin), un message par jour et par
  // personne. On note la livraison tout de suite (dates connues, rappel fait) pour ne pas
  // remettre en file au scan suivant ; message_id reste NULL jusqu'à l'ouverture de la fiche.
  // settings.immediate_cards = '1' : ancien envoi fiche par fiche (tests).
  const immediate = (await setting(env, "immediate_cards")) === "1";
  if (!immediate && pending.length) {
    const stmts = pending.flatMap((p) => {
      const lang = langOf.get(p.chat_id) ?? "fr";
      const h = header(p, byId.get(p.item_id)!, lang);
      return [
        env.DB.prepare(
          `INSERT INTO daily_queue (chat_id, item_id, kind, header) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(chat_id, item_id) DO UPDATE SET
             kind = CASE WHEN daily_queue.sent_at IS NULL AND daily_queue.kind = 'new' THEN 'new' ELSE excluded.kind END,
             header = CASE WHEN daily_queue.sent_at IS NULL AND daily_queue.kind = 'new' THEN NULL ELSE excluded.header END,
             sent_at = NULL, queued_at = datetime('now')`,
        ).bind(p.chat_id, p.item_id, p.kind, h),
        env.DB.prepare(
          `INSERT INTO deliveries (chat_id, item_id, dates, message_id, header, reminded, sent_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5, datetime('now'))
           ON CONFLICT(chat_id, item_id) DO UPDATE SET
             dates = (SELECT json_group_array(value) FROM (
                        SELECT value FROM json_each(deliveries.dates) UNION SELECT value FROM json_each(?3))),
             reminded = MAX(deliveries.reminded, ?5)`,
        ).bind(p.chat_id, p.item_id, JSON.stringify(p.dates), h, p.kind === "last_weeks" ? 1 : 0),
      ];
    });
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  }
  const messages = [...urgent.messages, ...(immediate ? pending : []).map((p) => {
    const item = byId.get(p.item_id)!;
    const lang = langOf.get(p.chat_id) ?? "fr";
    const h = header(p, item, lang);
    const { text, reply_markup } = renderFor(item, p.chat_id, react.get(`${p.chat_id}|${p.item_id}`) ?? null,
      friends.get(p.item_id) ?? [], h, lang);
    return { chat_id: p.chat_id, item_id: p.item_id, kind: p.kind, dates: p.dates, header: h, text, reply_markup } as any;
  })];
  // 🎟 Le lendemain d'une réservation : « Alors, c'était comment ? » (1–5★ puis avis).
  const { results: due } = await env.DB.prepare(
    `SELECT r.chat_id, r.item_id, i.title, u.lang FROM reactions r
     JOIN users u ON u.chat_id = r.chat_id AND u.active = 1 JOIN items i ON i.id = r.item_id
     WHERE r.booked_at IS NOT NULL AND substr(r.booked_at, 1, 10) < date('now')
       AND r.status IS NULL AND COALESCE(r.followup_sent, 0) = 0 LIMIT 40`,
  ).all<{ chat_id: number; item_id: string; title: string; lang: string }>();
  for (const f of due) {
    messages.push({
      chat_id: f.chat_id, item_id: f.item_id, kind: "followup",
      text: tr(asLang(f.lang)).howWasIt(esc(f.title)),
      reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `${n}★`, callback_data: `r:${f.item_id}:${n}` }))] },
    });
  }
  return Response.json({ messages });
}

async function urgentDates(
  env: Env, pending: Pending[], byId: Map<string, Item>, langOf: Map<number, Lang>,
): Promise<{ taken: Set<Pending>; messages: any[] }> {
  const sales: Record<string, { day: string; at: string | null }> = JSON.parse((await setting(env, "sales")) ?? "{}");
  const b = berlinNow(new Date());
  const saleOpen = (venue: string) => {
    const s = sales[venue];
    return !!s && s.day === b.day && (!s.at || b.hm >= berlinNow(new Date(s.at)).hm);
  };
  const taken = new Set(pending.filter((p) =>
    p.kind === "star_dates" || (p.kind === "new_dates" && saleOpen(byId.get(p.item_id)!.venue_id))));
  if (!taken.size) return { taken, messages: [] };
  const { results: vrows } = await env.DB.prepare("SELECT id, name FROM venues").all<{ id: string; name: string }>();
  const vname = new Map(vrows.map((v) => [v.id, v.name]));
  const stmts: D1PreparedStatement[] = [];
  const byChat = new Map<number, Pending[]>();
  for (const p of taken) {
    if (!byChat.has(p.chat_id)) byChat.set(p.chat_id, []);
    byChat.get(p.chat_id)!.push(p);
    stmts.push(env.DB.prepare(
      `INSERT INTO deliveries (chat_id, item_id, dates, message_id) VALUES (?1, ?2, ?3, NULL)
       ON CONFLICT(chat_id, item_id) DO UPDATE SET dates = (SELECT json_group_array(value) FROM (
         SELECT value FROM json_each(deliveries.dates) UNION SELECT value FROM json_each(?3)))`,
    ).bind(p.chat_id, p.item_id, JSON.stringify(p.dates)));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  const line = (p: Pending) => {
    const it = byId.get(p.item_id)!;
    const link = (it.text ?? "").match(/🎟 <a href="([^"]+)"/u)?.[1] ?? it.url;
    const title = link ? `<a href="${esc(link)}">${esc(it.title)}</a>` : `<b>${esc(it.title)}</b>`;
    const when = [...p.fresh].sort().slice(0, 8).map((d) => `${frDate(d)} ${d.slice(11, 16)}`.trim()).join(", ");
    return `🎟 ${title} <i>(${esc(vname.get(it.venue_id) ?? "")})</i> : ${when}${p.fresh.length > 8 ? ` (+${p.fresh.length - 8})` : ""}`;
  };
  const messages: any[] = [];
  for (const [chat, ps] of byChat) {
    const T = tr(langOf.get(chat) ?? "fr");
    const stars = ps.filter((p) => p.kind === "star_dates"), others = ps.filter((p) => p.kind !== "star_dates");
    const parts = [
      stars.length ? `${T.urgentStars}\n${stars.map(line).join("\n")}` : "",
      others.length ? `${T.urgentSale}\n${others.map(line).join("\n")}` : "",
    ].filter(Boolean);
    messages.push({ chat_id: chat, kind: "urgent", text: parts.join("\n\n") });
  }
  return { taken, messages };
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
    if (s.kind === "followup") {
      stmts.push(env.DB.prepare("UPDATE reactions SET followup_sent = 1 WHERE chat_id = ? AND item_id = ?").bind(s.chat_id, s.item_id));
      continue;
    }
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
  const h = await horizon(env);           // expos ouvertes / qui ouvrent bientôt ; pièces jouées bientôt
  const { results } = await env.DB.prepare(
    `SELECT i.*, v.name AS venue_name, v.position FROM items i
     JOIN venues v ON v.id = i.venue_id AND v.active = 1
     JOIN subscriptions s ON s.venue_id = i.venue_id AND s.chat_id = ?1
     LEFT JOIN reactions r ON r.item_id = i.id AND r.chat_id = ?1
     WHERE (r.status IS NULL) AND COALESCE(r.interested, 0) = 0
       AND (?2 IS NULL OR i.id IN (SELECT value FROM json_each(?2)))
       AND (?2 IS NOT NULL OR i.last_seen >= ?3 OR i.kind = 'film')
       AND (i.kind != 'film' OR (SELECT MAX(value) FROM json_each(i.dates)) >= ?5)
       AND ${windowSql(h)} AND ?4 = ?4
     ORDER BY CASE i.kind WHEN 'theatre' THEN 0 WHEN 'expo' THEN 1 ELSE 2 END, v.position, COALESCE(NULLIF(i.start_date, ''), json_extract(i.dates, '$[0]'), '9999')`,
  ).bind(chat_id, ids ? JSON.stringify(ids) : null, since ?? "", "", today()).all<Item & { venue_name: string }>();

  if (!results.length) {
    return [`${title}\n\n${T.digestEmpty}`];
  }
  const friends = await friendsByItem(env, results.map((r) => r.id));
  const nTheatre = results.filter((r) => r.kind === "theatre").length;
  const nFilm = results.filter((r) => r.kind === "film").length;
  const nExpo = results.length - nTheatre - nFilm;
  const counts = [nTheatre && T.plays(nTheatre), nExpo && T.expos(nExpo), nFilm && T.films(nFilm)]
    .filter(Boolean).join(" · ");

  const blocks: string[] = [];
  let section = "", venue = "";
  for (const it of results) {
    if (it.kind !== section) {
      section = it.kind;
      blocks.push(section === "theatre" ? T.theatreSection : section === "film" ? T.filmSection : T.expoSection);
      venue = "";
    }
    if (it.venue_name !== venue) {
      venue = it.venue_name;
      blocks.push(`\n📍 <b>${esc(venue)}</b>`);
    }
    const social = socialBlock(visibleTo(friends.get(it.id) ?? [], chat_id), chat_id, true, lang);
    blocks.push(itemLine(it, lang) + (social ? `\n${social}` : ""));
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
