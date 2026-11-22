/** Surveillance : on note ce qui va mal (côté serveur et côté téléphones) dans app_errors, et le cron (toutes les 15 min)
 *  prévient la propriétaire sur Telegram. Historique 24 h dans l'admin. Jamais bloquant : une note perdue ne casse rien. */
import { Env, send } from "./lib";

export type ErrRow = { src: "server" | "client"; kind: string; path?: string | null; status?: number | null; ms?: number | null; msg?: string | null; who?: string | null; ua?: string | null };

const SLOW_API_MS = 3000;          // une requête serveur plus lente que ça : notée
const EXPECTED_4XX = new Set([401, 404, 405, 409, 429]);   // session expirée, robots, conflit normal, limite anti-robots

export function logError(env: Env, ctx: ExecutionContext | null, e: ErrRow): Promise<void> {
  const p = env.DB.prepare("INSERT INTO app_errors (src, kind, path, status, ms, msg, who, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(e.src, e.kind, (e.path ?? "").slice(0, 120) || null, e.status ?? null, e.ms ?? null, (e.msg ?? "").slice(0, 500) || null, (e.who ?? "").slice(0, 40) || null, (e.ua ?? "").slice(0, 160) || null)
    .run().then(() => {}, (err) => console.log("monitor", String(err)));
  if (ctx) ctx.waitUntil(p);
  return p;
}

/** Qui a fait la requête (pour la colonne « Qui » des erreurs) : session web (Bearer) ou utilisateur Telegram (initData). */
async function whoOf(req: Request | null, env: Env): Promise<string | null> {
  if (!req) return null;
  try {
    let chat: number | null = null;
    const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)/);
    if (m) {
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1])))].map((b) => b.toString(16).padStart(2, "0")).join("");
      chat = (await env.DB.prepare("SELECT chat_id FROM web_sessions WHERE token_hash = ?").bind(h).first<{ chat_id: number }>())?.chat_id ?? null;
    } else {
      const init = String(((await req.json().catch(() => ({}))) as any).initData || "");
      const u = new URLSearchParams(init).get("user");
      chat = u ? Number(JSON.parse(u).id) || null : null;
    }
    if (!chat) return null;
    const u = await env.DB.prepare("SELECT first_name, handle FROM users WHERE chat_id = ?").bind(chat).first<{ first_name: string; handle: string | null }>();
    return u ? (u.handle ? `@${u.handle}` : u.first_name) : null;
  } catch { return null; }
}

/** Enveloppe chaque requête : plantage → 500 noté ; 5xx, 4xx inattendu (API seulement), lenteur → notés. */
export async function monitored(req: Request, env: Env, ctx: ExecutionContext, run: () => Promise<Response>): Promise<Response> {
  const t0 = Date.now(), path = new URL(req.url).pathname;
  const copy = req.method === "POST" && path.startsWith("/app/api/") ? req.clone() : null;   // pour retrouver qui, si ça rate
  const log = (e: ErrRow) => ctx.waitUntil(whoOf(copy, env).then((who) => logError(env, null, { ...e, who: e.who ?? who })));
  let res: Response;
  try { res = await run(); }
  catch (e: any) {
    log({ src: "server", kind: "5xx", path, status: 500, ms: Date.now() - t0, msg: String(e?.stack || e) });
    return new Response("Erreur serveur", { status: 500 });
  }
  const ms = Date.now() - t0;
  if (res.status >= 500) log({ src: "server", kind: "5xx", path, status: res.status, ms });
  else if (res.status >= 400 && path.startsWith("/app/api/") && path !== "/app/api/clientlog" && !EXPECTED_4XX.has(res.status)) {
    let msg = ""; try { msg = JSON.stringify(await res.clone().json()).slice(0, 200); } catch { /* pas du JSON */ }
    log({ src: "server", kind: "4xx", path, status: res.status, ms, msg });
  }
  else if (ms > SLOW_API_MS && path !== "/app/api/clientlog") log({ src: "server", kind: "slow_api", path, status: res.status, ms });
  return res;
}

const LABEL: Record<string, string> = {
  "5xx": "💥 Erreur serveur", "4xx": "⚠️ Requête refusée", slow_api: "🐢 Serveur lent", js: "🐞 Bug dans l'app",
  network: "📡 Réseau", slow_load: "🐢 Chargement lent",
};

/** Cron : s'il y a du neuf, un seul message à la propriétaire.
 *  Toujours : plantage serveur (5xx), bug dans l'app, chargement lent. Le reste (requête refusée — souvent une saisie invalide —,
 *  lenteur serveur, réseau) seulement en cas de pic : 10 ou plus depuis la dernière alerte. */
export async function alertErrors(env: Env): Promise<number> {
  if (!env.OWNER_CHAT_ID) return 0;
  const { results } = await env.DB.prepare(
    "SELECT kind, path, status, msg, COUNT(*) n, MAX(ms) ms, GROUP_CONCAT(DISTINCT who) who, MAX(id) last FROM app_errors WHERE alerted = 0 GROUP BY kind, path, status, substr(COALESCE(msg, ''), 1, 80) ORDER BY n DESC")
    .all<{ kind: string; path: string | null; status: number | null; msg: string | null; n: number; ms: number | null; who: string | null; last: number }>();
  await env.DB.prepare("DELETE FROM app_errors WHERE at < datetime('now', '-30 days')").run();
  if (!results.length) return 0;
  const serious = (r: { kind: string }) => r.kind === "5xx" || r.kind === "js" || r.kind === "slow_load";
  const total = results.reduce((a, r) => a + r.n, 0), minor = results.filter((r) => !serious(r)).reduce((a, r) => a + r.n, 0);
  if (!results.some(serious) && minor < 10) return 0;   // pas encore de quoi déranger : on garde pour la prochaine fois
  results.sort((a, b) => Number(serious(b)) - Number(serious(a)) || b.n - a.n);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = results.slice(0, 8).map((r) => {
    const what = [r.status ? String(r.status) : "", r.path || ""].filter(Boolean).join(" ");
    const extra = r.ms && /slow/.test(r.kind) ? ` · ${(r.ms / 1000).toFixed(1)} s` : "";
    const who = r.who ? ` · ${r.who.split(",").slice(0, 3).join(", ")}` : "";
    return `• ${LABEL[r.kind] || r.kind}${r.n > 1 ? ` ×${r.n}` : ""} — ${esc(what)}${extra}${who}${r.msg ? `\n  <i>${esc(r.msg.split("\n")[0].slice(0, 140))}</i>` : ""}`;
  });
  const text = `🚨 <b>Berlin Encore! : ${total} problème${total > 1 ? "s" : ""} depuis la dernière alerte</b>\n${lines.join("\n")}${results.length > 8 ? `\n… et ${results.length - 8} autres` : ""}\n\nDétails : Réglages → Admin → Erreurs.`;
  await send(env, env.OWNER_CHAT_ID, text);
  await env.DB.prepare("UPDATE app_errors SET alerted = 1 WHERE alerted = 0").run();
  return total;
}

/** Admin : les dernières 24 h, regroupées. */
export async function recentErrors(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT src, kind, path, status, substr(COALESCE(msg, ''), 1, 160) msg, COUNT(*) n, MAX(ms) ms, MAX(at) last, GROUP_CONCAT(DISTINCT who) who
     FROM app_errors WHERE at > datetime('now', '-1 day') GROUP BY src, kind, path, status, substr(COALESCE(msg, ''), 1, 80) ORDER BY last DESC LIMIT 60`).all<any>();
  return results;
}

// --- 💾 Stockage et quotas Cloudflare D1 -----------------------------------------------------------
// Taille : lue sur chaque requête D1 (meta.size_after), sans jeton. Lignes lues/écrites par jour : API analytics
// de Cloudflare, seulement si le secret CF_API_TOKEN (droit « Account Analytics : Read ») est posé.
// Limites par défaut = forfait gratuit (500 Mo par base, 5 M lignes lues et 100 k écrites par jour) ; ajustables.
export const storageLimits = (env: Env) => ({
  mb: Number(env.D1_LIMIT_MB || 500), reads: Number(env.D1_READS_DAY || 5_000_000), writes: Number(env.D1_WRITES_DAY || 100_000),
});
type Day = { d: string; mb?: number; reads?: number; writes?: number; rq?: number; wq?: number };

async function d1Usage(env: Env, since: string): Promise<Day[] | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.D1_DATABASE_ID) return null;
  const query = `query($a:String!,$s:Date!,$db:String!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:200,filter:{date_geq:$s,databaseId:$db},orderBy:[date_ASC]){dimensions{date} sum{readQueries writeQueries rowsRead rowsWritten}}}}}`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: since, db: env.D1_DATABASE_ID } }),
  });
  const j: any = await r.json().catch(() => null);
  const rows = j?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(rows)) { console.log("d1 usage", JSON.stringify(j?.errors || r.status).slice(0, 200)); return null; }
  return rows.map((x: any) => ({ d: x.dimensions.date, reads: x.sum.rowsRead, writes: x.sum.rowsWritten, rq: x.sum.readQueries, wq: x.sum.writeQueries }));
}

/** Cron : toutes les 6 h, note la taille et l'usage du jour (historique 120 jours, settings.storage_hist).
 *  Alerte Telegram (une fois par jour et par sujet) : base à plus de 80 % de sa taille max, lignes lues ou écrites
 *  à plus de 70 % du quota journalier. */
export async function storageCheck(env: Env, force = false): Promise<void> {
  const get = async (k: string) => (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first<{ value: string }>())?.value ?? null;
  const put = (k: string, v: string) => env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run();
  const last = await get("storage_at");
  if (!force && last && Date.now() - Date.parse(last) < 6 * 3600e3) return;
  const probe: any = await env.DB.prepare("SELECT COUNT(*) n FROM settings").run();
  const mb = Math.round(((probe?.meta?.size_after ?? 0) / 1048576) * 100) / 100;
  const today = new Date().toISOString().slice(0, 10);
  const hist: Day[] = JSON.parse((await get("storage_hist")) || "[]");
  const byDay = new Map(hist.map((h) => [h.d, h]));
  const usage = await d1Usage(env, new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)).catch(() => null);
  for (const u of usage || []) byDay.set(u.d, { ...(byDay.get(u.d) || { d: u.d }), ...u });
  if (mb) byDay.set(today, { ...(byDay.get(today) || { d: today }), mb });
  const out = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-120);
  await put("storage_hist", JSON.stringify(out));
  await put("storage_at", new Date().toISOString());
  if (!env.OWNER_CHAT_ID) return;
  const L = storageLimits(env), yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const y = byDay.get(yest) || {} as Day, t = byDay.get(today) || {} as Day;
  const worst = (k: "reads" | "writes") => Math.max(y[k] || 0, t[k] || 0);
  const warn: string[] = [];
  if (mb > 0.8 * L.mb) warn.push(`💾 Base : ${mb} Mo sur ${L.mb} Mo (${Math.round((100 * mb) / L.mb)} %)`);
  if (worst("reads") > 0.7 * L.reads) warn.push(`📖 Lignes lues sur une journée : ${worst("reads").toLocaleString("fr-FR")} sur ${L.reads.toLocaleString("fr-FR")} (${Math.round((100 * worst("reads")) / L.reads)} %)`);
  if (worst("writes") > 0.7 * L.writes) warn.push(`✍️ Lignes écrites sur une journée : ${worst("writes").toLocaleString("fr-FR")} sur ${L.writes.toLocaleString("fr-FR")} (${Math.round((100 * worst("writes")) / L.writes)} %)`);
  if (!warn.length || (await get("storage_alerted")) === today) return;
  await send(env, env.OWNER_CHAT_ID, `⚠️ <b>Berlin Encore! : stockage Cloudflare bientôt plein</b>\n${warn.join("\n")}\n\nDétails : /app/stats → Stockage.`);
  await put("storage_alerted", today);
}

/** Pour la page Stats : historique, limites, lignes par table. */
export async function storageReport(env: Env) {
  await storageCheck(env).catch(() => {});
  const hist = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'storage_hist'").first<{ value: string }>())?.value || "[]");
  const tables = ["items", "events", "reactions", "deliveries", "notifications", "users", "subscriptions", "app_errors", "rate_hits", "web_sessions", "push_subs", "proposals", "connections", "scan_reports"];
  const counts = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`)));
  return { hist, limits: storageLimits(env), analytics: !!env.CF_API_TOKEN,
    tables: tables.map((t, i) => ({ t, n: (counts[i].results?.[0] as any)?.n ?? 0 })).sort((a, b) => b.n - a.n) };
}
