// App web installable (PWA) : manifeste, icônes, service worker.
// Sur iPhone : Safari → Partager → « Sur l'écran d'accueil ». Plus tard : même page dans Capacitor.
import { ICON180, ICON512, MASKABLE512 } from "./icons";
import { LOGOS } from "./logos";

const png = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const ICONS: Record<string, string> = { "icon-180.png": ICON180, "icon-512.png": ICON512, "icon-maskable-512.png": MASKABLE512 };

const MANIFEST = {
  name: "Berlin Encore!",
  short_name: "Encore!",
  description: "Théâtre surtitré, expos et ciné en VO à Berlin, avec tes amis.",
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/app/icon-180.png", sizes: "180x180", type: "image/png" },
    { src: "/app/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/app/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// Réseau d'abord (jamais de programme périmé) ; la page en cache seulement hors ligne.
const SW = `const C = "be-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(C).then((c) => c.addAll(["/app"]))); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/app/api/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && u.pathname === "/app") caches.open(C).then((c) => c.put("/app", r.clone())); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("/app"))));
});`;

/** /app/<fichier> statique, sinon null. */
export function webAsset(path: string): Response | null {
  const name = path.replace(/^\/app\//, "");
  if (name === "manifest.webmanifest") return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json", "cache-control": "max-age=3600" } });
  if (name === "sw.js") return new Response(SW, { headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/app" } });
  const logo = name.match(/^logo\/([\w-]+)\.png$/);
  if (logo && LOGOS[logo[1]]) return new Response(png(LOGOS[logo[1]]), { headers: { "content-type": "image/png", "cache-control": "max-age=604800" } });
  if (ICONS[name]) return new Response(png(ICONS[name]), { headers: { "content-type": "image/png", "cache-control": "max-age=604800" } });
  return null;
}
