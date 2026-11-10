// Relais : seulement l'app (/app…) ; « / » mène à l'app. Le webhook et l'API du scraper
// restent sur l'adresse du Worker.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return Response.redirect(`${url.origin}/app${url.search}`, 302);
    if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return new Response("not found", { status: 404 });
    return env.BOT.fetch(new Request(req.url, req));
  },
};
