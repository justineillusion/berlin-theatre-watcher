/** Surveillance : on note ce qui va mal (côté serveur et côté téléphones) dans app_errors, et le cron (toutes les 15 min)
 *  prévient la propriétaire sur Telegram. Historique 24 h dans l'admin. Jamais bloquant : une note perdue ne casse rien. */
import { Env, send } from "./lib";

export type ErrRow = { src: "server" | "client"; kind: string; path?: string | null; status?: number | null; ms?: number | null; msg?: string | null; who?: string | null; ua?: string | null };

const SLOW_API_MS = 3000;          // une requête serveur plus lente que ça : notée
const EXPECTED_4XX = new Set([401, 404, 405, 409, 429]);   // session expirée, robots, conflit normal, limite anti-robots

export function logError(env: Env, ctx: ExecutionContext | null, e: ErrRow): void {
  const p = env.DB.prepare("INSERT INTO app_errors (src, kind, path, status, ms, msg, who, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(e.src, e.kind, (e.path ?? "").slice(0, 120) || null, e.status ?? null, e.ms ?? null, (e.msg ?? "").slice(0, 500) || null, (e.who ?? "").slice(0, 40) || null, (e.ua ?? "").slice(0, 160) || null)
    .run().then(() => {}, (err) => console.log("monitor", String(err)));
  if (ctx) ctx.waitUntil(p);
}

/** Enveloppe chaque requête : plantage → 500 noté ; 5xx, 4xx inattendu (API seulement), lenteur → notés. */
export async function monitored(req: Request, env: Env, ctx: ExecutionContext, run: () => Promise<Response>): Promise<Response> {
  const t0 = Date.now(), path = new URL(req.url).pathname;
  let res: Response;
  try { res = await run(); }
  catch (e: any) {
    logError(env, ctx, { src: "server", kind: "5xx", path, status: 500, ms: Date.now() - t0, msg: String(e?.stack || e) });
    return new Response("Erreur serveur", { status: 500 });
  }
  const ms = Date.now() - t0;
  if (res.status >= 500) logError(env, ctx, { src: "server", kind: "5xx", path, status: res.status, ms });
  else if (res.status >= 400 && path.startsWith("/app/api/") && path !== "/app/api/clientlog" && !EXPECTED_4XX.has(res.status)) {
    let msg = ""; try { msg = JSON.stringify(await res.clone().json()).slice(0, 200); } catch { /* pas du JSON */ }
    logError(env, ctx, { src: "server", kind: "4xx", path, status: res.status, ms, msg });
  }
  else if (ms > SLOW_API_MS && path !== "/app/api/clientlog") logError(env, ctx, { src: "server", kind: "slow_api", path, status: res.status, ms });
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
