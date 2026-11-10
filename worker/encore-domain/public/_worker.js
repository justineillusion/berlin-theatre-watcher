// Ancienne adresse (berlin-encore.pages.dev) : tout renvoie vers https://berlinencore.app.
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" || url.pathname === "/index.html" ? "/app" : url.pathname;
    return Response.redirect(`https://berlinencore.app${path}${url.search}`, 301);
  },
};
