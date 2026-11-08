// Berlin Theatre Watcher — bot multi-utilisateurs (Cloudflare Worker + D1).
//
//   POST /tg            webhook Telegram (vérifié par X-Telegram-Bot-Api-Secret-Token)
//   POST /api/plan      ┐
//   POST /api/render    ├ appelés par le scraper (Authorization: Bearer API_TOKEN)
//   POST /api/sent      ┘
//   POST /api/setup     enregistre le webhook + le menu des commandes (Bearer API_TOKEN)
import { handleUpdate } from "./bot";
import { Env, tg } from "./lib";
import { plan, render, sent } from "./scan";

function authorized(req: Request, env: Env): boolean {
  return !!env.API_TOKEN && req.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

const COMMANDS = [
  { command: "suivre", description: "Choisir ses théâtres et lieux d'expo" },
  { command: "programme", description: "Tout ce qui est à l'affiche dans mes lieux" },
  { command: "interets", description: "Ce qui tente la bande ⭐" },
  { command: "vus", description: "Mes sorties et mes notes" },
  { command: "ignores", description: "Réactiver une pièce/expo ignorée" },
  { command: "aide", description: "Comment ça marche" },
];

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
      case "/api/setup": {
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/tg`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        });
        const cmds = await tg(env, "setMyCommands", { commands: COMMANDS });
        return Response.json({ webhook: hook, commands: cmds });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
