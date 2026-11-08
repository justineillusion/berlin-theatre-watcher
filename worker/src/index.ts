// Berlin Theatre Watcher — bot multi-utilisateurs (Cloudflare Worker + D1).
//
//   POST /tg            webhook Telegram (vérifié par X-Telegram-Bot-Api-Secret-Token)
//   POST /api/plan      ┐
//   POST /api/render    ├ appelés par le scraper (Authorization: Bearer API_TOKEN)
//   POST /api/sent      │
//   POST /api/cinema-recipients │ ciné du dimanche : cinémas -> [{chat_id, venue_ids}]
//   POST /api/film-plan         │ films + sélection de chacun -> un message par film
//   POST /api/cinema-done       ┘ récap de la semaine envoyé (idempotence)
//   POST /api/setup     enregistre le webhook + le menu des commandes (Bearer API_TOKEN)
import { handleUpdate } from "./bot";
import { Env, tg } from "./lib";
import { setChatMenu, setGlobalMenus } from "./i18n";
import { cinemaDone, cinemaRecipients, filmPlan, plan, render, sent } from "./scan";

function authorized(req: Request, env: Env): boolean {
  return !!env.API_TOKEN && req.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
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
        await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } });
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
