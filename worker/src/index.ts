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
import { cinemaDone, cinemaRecipients, filmPlan, plan, render, sent } from "./scan";

function authorized(req: Request, env: Env): boolean {
  return !!env.API_TOKEN && req.headers.get("authorization") === `Bearer ${env.API_TOKEN}`;
}

const COMMANDS = [
  { command: "programme", description: "Tout ce qui est à l'affiche dans mes lieux" },
  { command: "suivre", description: "Choisir ses théâtres, lieux d'expo et cinémas" },
  { command: "interets", description: "Ce qui tente la bande ⭐" },
  { command: "vus", description: "Mes sorties et mes notes" },
  { command: "ignores", description: "Réactiver une pièce/expo ignorée" },
  { command: "langue", description: "🇫🇷 Français / 🇬🇧 English" },
  { command: "aide", description: "Comment ça marche" },
];
// Menu affiché aux applis Telegram en anglais (la langue des MESSAGES, elle, se choisit par /langue).
const COMMANDS_EN = [
  { command: "programme", description: "Everything on in my venues" },
  { command: "suivre", description: "Choose theatres, exhibition venues and cinemas" },
  { command: "interets", description: "What the gang fancies ⭐" },
  { command: "vus", description: "My outings and ratings" },
  { command: "ignores", description: "Un-ignore a play/exhibition" },
  { command: "language", description: "🇫🇷 Français / 🇬🇧 English" },
  { command: "aide", description: "How it works" },
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
        const priv = { type: "all_private_chats" };
        const cmds = await tg(env, "setMyCommands", { commands: COMMANDS });
        await tg(env, "setMyCommands", { commands: COMMANDS, scope: priv });
        await tg(env, "setMyCommands", { commands: COMMANDS_EN, scope: priv, language_code: "en" });
        await tg(env, "setMyCommands", { commands: COMMANDS_EN, language_code: "en" });
        await tg(env, "setMyCommands", {
          commands: COMMANDS.filter((c) => c.command === "interets" || c.command === "programme"),
          scope: { type: "all_group_chats" },
        });
        await tg(env, "setChatMenuButton", { menu_button: { type: "commands" } });
        return Response.json({ webhook: hook, commands: cmds });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
