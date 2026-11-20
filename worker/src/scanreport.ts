// Santé des scans : les scripts Python envoient, par lieu, ce qu'ils ont trouvé et ce qu'ils ont écarté
// (POST /api/scan-report) ; la page /admin (admin.html) lit POST /app/api/admin/scans.
import type { Env } from "./lib";

type VenueReport = { venue: string; found: number; kept: number; dropped?: Record<string, string[]>; error?: string | null };

export async function saveScanReport(env: Env, body: any): Promise<Response> {
  const kind = String(body.kind ?? ""), run = String(body.run ?? "") || new Date().toISOString();
  const venues: VenueReport[] = Array.isArray(body.venues) ? body.venues.slice(0, 200) : [];
  if (!["theatre", "cinema"].includes(kind) || !venues.length) return Response.json({ error: "bad_request" }, { status: 400 });
  const ins = env.DB.prepare("INSERT INTO scan_reports (run, kind, venue, found, kept, dropped, error) VALUES (?, ?, ?, ?, ?, ?, ?)");
  await env.DB.batch([
    ...venues.map((v) => ins.bind(run, kind, String(v.venue).slice(0, 80), Math.max(0, v.found | 0), Math.max(0, v.kept | 0),
      v.dropped && Object.keys(v.dropped).length ? JSON.stringify(v.dropped).slice(0, 4000) : null, v.error ? String(v.error).slice(0, 300) : null)),
    env.DB.prepare("DELETE FROM scan_reports WHERE at < datetime('now', '-60 days')"),
  ]);
  return Response.json({ ok: true, saved: venues.length });
}

const synOf = (text: string) => {
  const m = String(text || "").match(/📝\s*([\s\S]*?)(?:<\/blockquote>|\n\n|$)/);
  return m ? m[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "";
};

/** Dernier passage de chaque type, comparé au précédent, et les contrôles sur la base. */
export async function adminScans(env: Env) {
  const runs: any = {};
  for (const kind of ["theatre", "cinema"]) {
    const { results: last } = await env.DB.prepare(
      "SELECT DISTINCT run, MAX(at) AS at FROM scan_reports WHERE kind = ? GROUP BY run ORDER BY at DESC LIMIT 2").bind(kind).all<any>();
    if (!last.length) { runs[kind] = null; continue; }
    const { results: now } = await env.DB.prepare("SELECT venue, found, kept, dropped, error FROM scan_reports WHERE run = ? AND kind = ? ORDER BY venue").bind(last[0].run, kind).all<any>();
    const prev = new Map<string, number>();
    if (last[1]) {
      const { results: before } = await env.DB.prepare("SELECT venue, kept FROM scan_reports WHERE run = ? AND kind = ?").bind(last[1].run, kind).all<any>();
      before.forEach((r: any) => prev.set(r.venue, r.kept));
    }
    runs[kind] = { at: last[0].at, venues: now.map((r: any) => ({ ...r, dropped: r.dropped ? JSON.parse(r.dropped) : {}, prev: prev.has(r.venue) ? prev.get(r.venue) : null })) };
  }
  // Contrôles sur ce que l'app montre (fiches vues ces 2 derniers jours).
  const { results: empty } = await env.DB.prepare(
    `SELECT v.id, v.name, v.kind FROM venues v WHERE v.active = 1
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.venue_id = v.id AND i.last_seen > datetime('now', '-2 days')) ORDER BY v.name`).all<any>();
  const { results: items } = await env.DB.prepare(
    "SELECT i.id, i.kind, i.title, v.name AS venue, i.text FROM items i JOIN venues v ON v.id = i.venue_id WHERE i.last_seen > datetime('now', '-2 days') LIMIT 2000").all<any>();
  const noSyn = items.filter((i: any) => !synOf(i.text)).map((i: any) => ({ id: i.id, kind: i.kind, title: i.title, venue: i.venue }));
  const bySyn = new Map<string, any[]>();
  for (const i of items) {
    const s = synOf(i.text);
    if (s.length < 60) continue;
    const k = s.slice(0, 200).toLowerCase();
    (bySyn.get(k) ?? bySyn.set(k, []).get(k)!).push(i);
  }
  const norm = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9äöüßéèàç]+/g, "");
  const dupSyn = [...bySyn.values()].filter((g) => new Set(g.map((i) => norm(i.title))).size > 1)
    .map((g) => ({ text: synOf(g[0].text).slice(0, 140), items: g.map((i) => ({ title: i.title, venue: i.venue })) }));
  return { runs, checks: { empty, noSyn, dupSyn, total: items.length } };
}
