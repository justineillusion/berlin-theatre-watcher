// Berlin Theatre Watcher — bot multi-utilisateurs (Cloudflare Worker + D1).
//
//   POST /tg            webhook Telegram (vérifié par X-Telegram-Bot-Api-Secret-Token)
//   POST /api/plan      ┐
//   POST /api/render    ├ appelés par le scraper (Authorization: Bearer API_TOKEN)
//   POST /api/sent      │
//   POST /api/cinema-recipients │ ciné du dimanche : cinémas -> [{chat_id, venue_ids}]
//   POST /api/film-plan         │ films + sélection de chacun -> un message par film
//   POST /api/cinema-done       ┘ récap de la semaine envoyé (idempotence)
//   GET  /app           mini-app Telegram (+ POST /app/api/state, /app/api/act) : voir app.ts
//   POST /api/setup     enregistre le webhook + le menu des commandes (Bearer API_TOKEN)
import { handleUpdate } from "./bot";
import { handleApp } from "./app";
import { Env, loadCircles, tg } from "./lib";
import { setChatMenu, setGlobalMenus } from "./i18n";
import { cinemaDone, cinemaRecipients, filmPlan, plan, render, sent } from "./scan";
import { salesTick } from "./sales";
import { dailyTick } from "./daily";

function authorized(req: Request, env: Env): boolean {
  return !!env.API_TOKEN && req.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

export default {
  // Cron du Worker (wrangler.toml) : ouvertures de vente, à l'heure de Berlin.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await loadCircles(env);   // qui voit les ⭐ de qui (lib.ts)
    ctx.waitUntil(salesTick(env).then(() => undefined).catch((e) => console.log("sales tick failed", e)));
    ctx.waitUntil(dailyTick(env).then(() => undefined).catch((e) => console.log("daily tick failed", e)));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    await loadCircles(env).catch((e) => console.log("circles", e));   // qui voit les ⭐ de qui (lib.ts)
    // Mini-app Telegram (page + ses deux routes, authentifiées par initData).
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) return handleApp(req, env, ctx);
    if (req.method === "GET" && url.pathname === "/") return Response.redirect(`${url.origin}/app${url.search}`, 302);
    if (req.method !== "POST") return new Response("🎭", { status: 200 });

    if (url.pathname === "/tg") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await req.json();
      try {
        await handleUpdate(env, update, ctx);
      } catch (err) {
        // Toujours répondre 200 : sinon Telegram renvoie la même update en boucle.
        console.log("update failed", err instanceof Error ? err.stack : err);
      }
      return new Response("ok");
    }

    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });
    const body: any = await req.json().catch(() => ({}));

    switch (url.pathname) {
      case "/api/plan": return plan(env, body);
      case "/api/render": return render(env, body);
      case "/api/sent": return sent(env, body);
      case "/api/cinema-recipients": return cinemaRecipients(env, body);
      case "/api/cinema-done": return cinemaDone(env, body);
      case "/api/film-plan": return filmPlan(env, body);
      // Une passe du cron des ventes à une heure donnée (tests / rattrapage manuel).
      case "/api/daily-tick": return Response.json({ sent: await dailyTick(env, body.now ? new Date(body.now) : new Date()) });
      case "/api/sales-tick": return Response.json({ sent: await salesTick(env, body.now ? new Date(body.now) : new Date()) });
      case "/api/setup": {
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/tg`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        });
        // Mêmes portées que celles posées à la main : défaut + chats privés (fr),
        // chats privés en anglais, groupes (2 commandes), et bouton « menu ».
        const cmds = await setGlobalMenus(env);
        // Bouton à gauche du champ de saisie : ouvre la mini-app (les /commandes restent tapables).
        await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Berlin Encore!", web_app: { url: `${url.origin}/app` } } });
        // Telegram choisit le menu selon la langue de l'APPLI : on pose donc, par
        // chat, le menu dans la langue choisie par la personne (users.lang).
        const { results: users } = await env.DB.prepare(
          "SELECT chat_id, lang FROM users WHERE active = 1 LIMIT 40").all<{ chat_id: number; lang: string | null }>();
        for (const u of users) await setChatMenu(env, u.chat_id, u.lang);
        return Response.json({ webhook: hook, commands: cmds });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
