// Ouvertures de vente (Vorverkauf) : rappel la veille à 19:00 (heure de Berlin) et
// « 🎟 C'est ouvert » à l'heure d'ouverture. Calendrier : settings.sales, rempli
// par chaque scan (src/sales.py). Cron du Worker toutes les 15 min (à l'heure,
// contrairement aux crons GitHub qui dérivent de plusieurs heures).
import { Lang, asLang, tr } from "./i18n";
import { Env, esc, send, setSetting, setting } from "./lib";

export interface Sale {
  venue_id: string;
  day: string;              // « 2026-12-01 » (Berlin)
  at: string | null;        // ISO avec fuseau ; null = heure non publiée (Volksbühne)
  month: string;            // mois couvert, « 2027-01 »
  hour_known: boolean;
  source: string;
}

/** Date et heure de Berlin : { day: '2026-11-30', hm: '19:00' }. */
export function berlinNow(now: Date): { day: string; hm: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

const dayBefore = (day: string) => new Date(Date.parse(day + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);

/** Mes ⭐ (pas vus, pas réservés) dans ce lieu, avec le lien de réservation de la fiche. */
async function starsAt(env: Env, chat: number, venue: string): Promise<{ title: string; link: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.title, i.url, i.text FROM reactions r JOIN items i ON i.id = r.item_id
     WHERE r.chat_id = ? AND i.venue_id = ? AND r.interested = 1 AND r.status IS NULL AND r.booked_at IS NULL
     ORDER BY i.title LIMIT 15`,
  ).bind(chat, venue).all<{ title: string; url: string | null; text: string | null }>();
  return results.map((r) => ({
    title: r.title,
    link: (r.text ?? "").match(/🎟 <a href="([^"]+)"/u)?.[1] ?? r.url,
  }));
}

const list = (items: { title: string; link: string | null }[]) =>
  items.map((s) => `• ${s.link ? `<a href="${s.link}">${esc(s.title)}</a>` : esc(s.title)}`).join("\n");

/** Une passe du cron (exportée pour les tests : `now` simulé). Renvoie le nombre de messages envoyés. */
export async function salesTick(env: Env, now = new Date()): Promise<number> {
  const raw = await setting(env, "sales");
  if (!raw) return 0;
  const sales: Record<string, Sale> = JSON.parse(raw);
  const b = berlinNow(now);
  let n = 0;
  for (const s of Object.values(sales)) {
    // Veille, 19:00–23:59 ; jour J : à l'heure (ou 09:00 si l'heure n'est pas publiée), dans les 3 h.
    const openAt = s.at ? berlinNow(new Date(s.at)).hm : "09:00";
    const eve = b.day === dayBefore(s.day) && b.hm >= "19:00";
    const open = b.day === s.day && b.hm >= openAt && b.hm < String(Number(openAt.slice(0, 2)) + 3).padStart(2, "0") + openAt.slice(2);
    if (!eve && !open) continue;
    const kind = eve ? "eve" : "open";
    const key = `sale_sent:${kind}:${s.venue_id}:${s.day}`;
    if (await setting(env, key)) continue;
    await setSetting(env, key, new Date().toISOString());   // avant l'envoi : jamais deux fois
    const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(s.venue_id).first<{ name: string }>();
    const { results: subs } = await env.DB.prepare(
      `SELECT u.chat_id, u.lang FROM subscriptions x JOIN users u ON u.chat_id = x.chat_id AND u.active = 1
       WHERE x.venue_id = ? LIMIT 40`,
    ).bind(s.venue_id).all<{ chat_id: number; lang: string | null }>();
    for (const u of subs) {
      const lang: Lang = asLang(u.lang);
      const T = tr(lang);
      const month = T.monthsFull[Number(s.month.slice(5, 7)) - 1];
      const mine = await starsAt(env, u.chat_id, s.venue_id);
      let text: string;
      if (eve) {
        const when = s.at ? T.saleHour(openAt) : T.saleSomeTime;
        text = T.saleTomorrow(when, esc(venue?.name ?? s.venue_id), month) + (mine.length ? `\n${T.saleYourStars}\n${list(mine)}` : "");
      } else {
        if (!mine.length) continue;                          // pas de ⭐ là-bas : rien (la veille suffisait)
        text = (s.at ? T.saleOpen : T.saleToday)(esc(venue?.name ?? s.venue_id), month) + `\n${list(mine)}`;
      }
      await send(env, u.chat_id, text);
      n++;
    }
  }
  return n;
}
