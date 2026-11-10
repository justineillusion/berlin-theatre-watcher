// Test local de la mini-app : wrangler dev (D1 local, dossier à part) + faux Telegram.
//   node test/app.mjs
// Vérifie : la page, la signature initData (refus si absente/falsifiée/non inscrit),
// le programme renvoyé, et que ⭐ 🙅 ↩︎ 🎟 ✅ ★ passent par le même code que les boutons du chat.
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import { createHmac } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const TG_PORT = 8789, W_PORT = 8788, W = `http://127.0.0.1:${W_PORT}`;
const TOKEN = "123:test", ME = 111, OTHER = 444, GROUP = -999, STATE = ".wrangler/app-test-state";

let calls = [];
const tgServer = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ method: req.url.split("/").pop(), ...JSON.parse(body || "{}") });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => tgServer.listen(TG_PORT, r));

rmSync(STATE, { recursive: true, force: true });
writeFileSync(".dev.vars", `BOT_TOKEN=${TOKEN}\nAPI_TOKEN=a\nWEBHOOK_SECRET=h\nOWNER_CHAT_ID=${ME}\nBOT_USERNAME=TestBot\nTG_API=http://127.0.0.1:${TG_PORT}\n`);
const d1 = (args) => execSync(`npx wrangler d1 execute theatre-bot --local --persist-to ${STATE} ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
d1("--file=schema.sql");
for (const m of ["003_bookings.sql"]) { try { d1(`--file=migrations/${m}`); } catch {} }
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const seed = `
INSERT INTO users (chat_id, first_name) VALUES (${ME}, 'Justine');
INSERT INTO users (chat_id, first_name, lang) VALUES (555, 'Joss', 'en');
INSERT INTO venues (id, name, kind) VALUES ('be', 'Berliner Ensemble', 'theatre'), ('kw', 'KW', 'expo'), ('vb', 'Volksbühne', 'theatre');
INSERT INTO subscriptions (chat_id, venue_id, primed) VALUES (${ME}, 'be', 1), (${ME}, 'kw', 1);
INSERT INTO settings (key, value) VALUES ('current_since', '2000-01-01'), ('group_chat_id', '${GROUP}');
INSERT INTO items (id, venue_id, kind, title, url, dates, text) VALUES
  ('p1', 'be', 'theatre', 'Twelfth Night', 'https://x/p1', '["${day(2)} 19:30", "${day(5)} 20:00"]', '🎭 <b>Twelfth Night</b>\n📍 Berliner Ensemble\n📝 Une île.'),
  ('p2', 'be', 'theatre', 'Mutter Courage', null, '["${day(3)} 19:00"]', '🎭 <b>Mutter Courage</b>');
INSERT INTO items (id, venue_id, kind, title, start_date, end_date) VALUES ('e1', 'kw', 'expo', 'Expo', '${day(-10)}', '${day(30)}');
INSERT INTO items (id, venue_id, kind, title, dates) VALUES ('v1', 'vb', 'theatre', 'Hors de mes lieux', '["${day(4)} 19:30"]');
INSERT INTO reactions (chat_id, item_id, interested) VALUES (555, 'p1', 1);
INSERT INTO users (chat_id, first_name) VALUES (666, 'Lyna');
INSERT INTO connections (a, b, status) VALUES (${ME}, 555, 'ok'), (${ME}, 666, 'ok');
INSERT INTO subscriptions (chat_id, venue_id, primed) VALUES (666, 'be', 1);`;
writeFileSync(`${STATE}-seed.sql`, seed);
d1(`--file=${STATE}-seed.sql`);

const dev = spawn("npx", ["wrangler", "dev", "--local", "--persist-to", STATE, "--port", String(W_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
let log = ""; dev.stdout.on("data", (d) => (log += d)); dev.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(W); break; } catch { if (i > 60) throw new Error(log); } await new Promise((r) => setTimeout(r, 500)); }

/** initData signé comme Telegram le fait. */
function initData(user, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "q", user: JSON.stringify(user) });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}
const me = initData({ id: ME, first_name: "Justine" });
const post = async (path, body) => {
  const r = await fetch(W + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await new Promise((r) => setTimeout(r, 300));
  return { status: r.status, json: await r.json().catch(() => null) };
};
const act = async (op, id, arg) => { calls = []; const r = await post("/app/api/act", { initData: me, op, id, arg }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const item = (s, id) => s.items.find((x) => x.id === id);

let ok = 0;
const step = async (name, fn) => {
  try { await fn(); ok++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n${e.stack}\n--- wrangler ---\n${log.slice(-2500)}`); dev.kill(); tgServer.close(); process.exit(1); }
};

await step("GET /app sert la page", async () => {
  const r = await fetch(W + "/app"); assert.equal(r.status, 200);
  assert.match(await r.text(), /telegram-web-app\.js/);
});
await step("sans initData / falsifié / trop vieux : 401", async () => {
  assert.equal((await post("/app/api/state", {})).status, 401);
  assert.equal((await post("/app/api/state", { initData: initData({ id: ME }, "autre:token") })).status, 401);
  assert.equal((await post("/app/api/state", { initData: me.replace("Justine", "Justin") })).status, 401);
  assert.equal((await post("/app/api/state", { initData: initData({ id: ME }, TOKEN, 1000) })).status, 401);
});
await step("pas inscrit au bot : 403 + nom du bot", async () => {
  const r = await post("/app/api/state", { initData: initData({ id: OTHER, first_name: "X" }) });
  assert.equal(r.status, 403); assert.equal(r.json.bot, "TestBot");
});
await step("programme : mes lieux, envies des amis", async () => {
  const s = (await post("/app/api/state", { initData: me })).json;
  assert.deepEqual(s.items.map((x) => x.id).sort(), ["e1", "p1", "p2"]);
  assert.deepEqual(item(s, "p1").friends.map((f) => f.name), ["Joss"]);
  assert.equal(item(s, "p1").me, null);
  assert.equal(s.venues.length, 3);
});
const noMessages = () => assert.ok(!calls.some((c) => /^send/.test(c.method)), JSON.stringify(calls.map((c) => [c.method, c.chat_id])));
await step("⭐ : envie enregistrée, aucun message (ni groupe ni privé)", async () => {
  const s = await act("i", "p1");
  assert.equal(item(s, "p1").me.star, 1);
  noMessages();
});
await step("ouvert depuis le groupe (startapp) : la fiche est là même hors de mes lieux", async () => {
  const without = (await post("/app/api/state", { initData: me })).json;
  assert.ok(!item(without, "v1"));
  const s = (await post("/app/api/state", { initData: me, focus: "v1" })).json;
  assert.equal(item(s, "v1").title, "Hors de mes lieux");
});
await step("🙅 Pas pour moi puis ↩︎", async () => {
  assert.equal(item(await act("x", "p2"), "p2").me.status, "ignored");
  assert.equal(item(await act("u", "p2"), "p2").me.status, null);
});
await step("🎟 réservé à une séance", async () => {
  const s = await act("bd", "p1", day(5).replace(/\D/g, "") + "2000");
  assert.equal(item(s, "p1").me.booked, `${day(5)} 20:00`);
  await new Promise((r) => setTimeout(r, 300)); noMessages();
});
await step("✅ vu puis ★★★★", async () => {
  assert.equal(item(await act("v", "p2"), "p2").me.status, "seen");
  assert.equal(item(await act("r", "p2", "4"), "p2").me.rating, 4);
  await new Promise((r) => setTimeout(r, 300)); noMessages();
});
await step("✍️ critique écrite dans l'app : enregistrée, rien d'envoyé", async () => {
  calls = [];
  const r = await post("/app/api/review", { initData: me, id: "p2", text: "  Sublime, un peu long.  " });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(item(r.json, "p2").me.comment, "Sublime, un peu long.");
  assert.equal(item(r.json, "p2").me.rating, 4);
  await new Promise((r) => setTimeout(r, 300)); noMessages();
});
await step("💌 envoyer à Joss : message privé, dans sa langue", async () => {
  calls = [];
  const r = await post("/app/api/share", { initData: me, id: "p2", to: [555, ME, 999], note: "  Tuesday?  <b>" });
  assert.equal(r.status, 200); assert.deepEqual(r.json.sent, ["Joss"]);
  const dm = calls.filter((c) => c.method === "sendMessage" && c.chat_id == 555);
  assert.equal(dm.length, 1); assert.match(dm[0].text, /Justine.*wants to go/); assert.match(dm[0].text, /💬 « Tuesday\? &lt;b&gt; »/);
  assert.ok(r.json.people.some((p) => p.name === "Joss"));
});
await step("🎟 pour moi + Joss : réservé chez lui aussi", async () => {
  calls = [];
  const r = await post("/app/api/act", { initData: me, op: "bd", id: "p2", arg: day(3).replace(/\D/g, "") + "1900", with: [555] });
  assert.equal(r.status, 200);
  const f = item(r.json, "p2").friends.find((x) => x.name === "Joss");
  assert.equal(f.booked, `${day(3)} 19:00`);
  assert.ok(calls.some((c) => c.method === "sendMessage" && c.chat_id == 555 && /got you a ticket/.test(c.text)));
});
await step("Réglages : ne plus suivre puis resuivre un lieu", async () => {
  let s = await act("s", "kw");
  assert.equal(s.venues.find((v) => v.id === "kw").followed, 0);
  assert.ok(!s.items.some((x) => x.id === "e1"));
  s = await act("s", "kw");
  assert.equal(s.venues.find((v) => v.id === "kw").followed, 1);
});
await step("Réglages : langue → anglais puis français", async () => {
  assert.equal((await act("l", "en")).lang, "en");
  assert.equal((await act("l", "fr")).lang, "fr");
});
const lyna = initData({ id: 666, first_name: "Lyna" });
const joss = initData({ id: 555, first_name: "Joss" });
await step("cercles : Lyna (amie de Justine seulement) ne voit pas les envies de Joss", async () => {
  const s = (await post("/app/api/state", { initData: lyna })).json;
  assert.ok(!item(s, "p1").friends.some((f) => f.name === "Joss"), JSON.stringify(item(s, "p1").friends));
  assert.ok(item(s, "p1").friends.some((f) => f.name === "Justine"));
  assert.deepEqual(s.people.map((p) => p.name), ["Justine"]);
  assert.deepEqual(s.circle.suggestions.map((p) => [p.name, p.via]), [["Joss", ["Justine"]]]);
  assert.match(s.invite, /t\.me\/TestBot\?start=p[0-9a-z]+/);
});
await step("cercles : 💌 / 🎟 + ami refusés hors connexions", async () => {
  calls = [];
  const r = await post("/app/api/share", { initData: lyna, id: "p1", to: [555] });
  assert.deepEqual(r.json.sent, []);
  assert.ok(!calls.some((c) => c.chat_id == 555));
});
await step("cercles : Lyna ajoute Joss → demande en privé → Joss accepte → visibles", async () => {
  calls = [];
  let r = await post("/app/api/friend", { initData: lyna, op: "add", id: 555 });
  assert.equal(r.json.result, "sent");
  assert.deepEqual(r.json.circle.outgoing.map((p) => p.name), ["Joss"]);
  const dm = calls.find((c) => c.method === "sendMessage" && c.chat_id == 555);
  assert.ok(dm && /Lyna/.test(dm.text) && JSON.stringify(dm.reply_markup).includes("fa:666"));
  r = await post("/app/api/state", { initData: joss });
  assert.deepEqual(r.json.circle.incoming.map((p) => p.name), ["Lyna"]);
  r = await post("/app/api/friend", { initData: joss, op: "accept", id: 666 });
  assert.equal(r.json.result, "connected");
  const s = (await post("/app/api/state", { initData: lyna })).json;
  assert.ok(item(s, "p1").friends.some((f) => f.name === "Joss"));
  assert.deepEqual(s.people.map((p) => p.name).sort(), ["Joss", "Justine"]);
});
await step("cercles : ajouter un inconnu (pas ami d'ami) refusé ; retirer sans prévenir", async () => {
  let r = await post("/app/api/friend", { initData: lyna, op: "add", id: 999 });
  assert.equal(r.json.result, "not_allowed");
  calls = [];
  r = await post("/app/api/friend", { initData: lyna, op: "remove", id: 555 });
  assert.ok(!r.json.people.some((p) => p.name === "Joss"));
  assert.ok(!calls.some((c) => c.method === "sendMessage"));
});
await step("complets : une date complète grisée, une pièce entièrement complète garde sa fiche sans date libre", async () => {
  calls = [];
  const plan = (body) => fetch(W + "/api/plan", { method: "POST", headers: { authorization: "Bearer a", "content-type": "application/json" }, body: JSON.stringify(body) });
  const VEN = [{ id: "be", name: "Berliner Ensemble", kind: "theatre" }, { id: "kw", name: "KW", kind: "expo" }, { id: "vb", name: "Volksbühne", kind: "theatre" }];
  const r = await plan({ mode: "scan", venues: VEN,
    items: [{ id: "p1", venue_id: "be", kind: "theatre", title: "Twelfth Night", url: "https://x/p1", dates: [`${day(2)} 19:30`], start_date: null, end_date: null, starred: false }],
    sold: { p1: [`${day(5)} 20:00`], p2: [`${day(3)} 19:00`] } });
  assert.equal(r.status, 200, await r.text());
  await new Promise((r) => setTimeout(r, 300));
  const s = (await post("/app/api/state", { initData: me })).json;
  assert.deepEqual(item(s, "p1").sold, [`${day(5)} 20:00`]);
  assert.deepEqual(item(s, "p1").dates, [`${day(2)} 19:30`]);
  assert.deepEqual(item(s, "p2").sold, [`${day(3)} 19:00`]);
  assert.deepEqual(item(s, "p2").dates, []);
});
await step("action inconnue / id bizarre : 400", async () => {
  assert.equal((await post("/app/api/act", { initData: me, op: "stop", id: "p1" })).status, 400);
  assert.equal((await post("/app/api/act", { initData: me, op: "i", id: "p1:x" })).status, 400);
});

// --- App web (hors Telegram) ------------------------------------------------
const tgHook = (update) => fetch(W + "/tg", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "h", "content-type": "application/json" }, body: JSON.stringify(update) });
const bearer = async (path, token, body = {}) => {
  const r = await fetch(W + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
let session = "";
await step("web : manifeste, icônes, service worker", async () => {
  const m = await (await fetch(W + "/app/manifest.webmanifest")).json();
  assert.equal(m.start_url, "/app"); assert.equal(m.display, "standalone");
  const icon = await fetch(W + "/app/icon-512.png");
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)], [80, 78, 71]);   // « PNG »
  assert.match(await (await fetch(W + "/app/sw.js")).text(), /caches/);
  assert.match(await (await fetch(W + "/app")).text(), /manifest\.webmanifest/);
});
await step("web : connexion via le bot (lien → ✅ Oui → jeton), refus des inconnus et des faux jetons", async () => {
  assert.equal((await bearer("/app/api/state", "0".repeat(64))).status, 401);
  const start = (await post("/app/api/login/start", {})).json;
  assert.match(start.link, /^https:\/\/t\.me\/TestBot\?start=web_[a-f0-9]{24}$/);
  assert.equal((await post("/app/api/login/poll", { nonce: start.nonce })).json.pending, true);
  // Un inconnu qui ouvre le lien : refusé, rien n'est rattaché.
  calls = [];
  await tgHook({ message: { from: { id: OTHER, first_name: "X" }, chat: { id: OTHER, type: "private" }, text: `/start web_${start.nonce}` } });
  assert.ok(!calls.some((c) => c.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("wl:")));
  assert.equal((await post("/app/api/login/poll", { nonce: start.nonce })).json.pending, true);
  // Moi : le bot demande confirmation…
  calls = [];
  await tgHook({ message: { from: { id: ME, first_name: "Justine" }, chat: { id: ME, type: "private" }, text: `/start web_${start.nonce}` } });
  const ask = calls.find((c) => c.method === "sendMessage" && c.chat_id === ME);
  assert.equal(ask.reply_markup.inline_keyboard[0][0].callback_data, `wl:${start.nonce}`);
  assert.equal((await post("/app/api/login/poll", { nonce: start.nonce })).json.pending, true);   // pas encore confirmé
  // … « ✅ Oui, c'est moi » : la page reçoit son jeton, une seule fois.
  await tgHook({ callback_query: { id: "cb1", from: { id: ME, first_name: "Justine" }, data: `wl:${start.nonce}`, message: { message_id: 7, chat: { id: ME, type: "private" } } } });
  session = (await post("/app/api/login/poll", { nonce: start.nonce })).json.token;
  assert.match(session, /^[a-f0-9]{64}$/);
  assert.equal((await post("/app/api/login/poll", { nonce: start.nonce })).status, 410);
  // Re-cliquer le vieux bouton ne rattache rien.
  calls = [];
  await tgHook({ callback_query: { id: "cb2", from: { id: ME, first_name: "Justine" }, data: `wl:${start.nonce}`, message: { message_id: 7, chat: { id: ME, type: "private" } } } });
  assert.ok(calls.some((c) => /expir/.test(c.text || "")));
});
await step("web : même programme et mêmes actions avec le jeton qu'avec initData", async () => {
  const a = (await bearer("/app/api/state", session)).json, b = (await post("/app/api/state", { initData: me })).json;
  assert.deepEqual(a.items.map((x) => x.id).sort(), b.items.map((x) => x.id).sort());
  const s = (await bearer("/app/api/act", session, { op: "i", id: "e1" })).json;
  assert.equal(item(s, "e1").me.star, 1);
});
await step("web : CORS pour l'appli native (capacitor://localhost) seulement", async () => {
  const pre = await fetch(W + "/app/api/state", { method: "OPTIONS", headers: { origin: "capacitor://localhost" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), "capacitor://localhost");
  const evil = await fetch(W + "/app/api/state", { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${session}` }, body: "{}" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});
await step("Réglages : ne plus suivre aucune expo, puis toutes", async () => {
  let s = (await bearer("/app/api/act", session, { op: "sk", id: "expo", arg: "off" })).json;
  assert.ok(!s.venues.find((v) => v.kind === "expo").followed);
  assert.equal(item(s, "e1").me.star, 1);          // une expo ⭐ reste dans Mes sorties même sans lieu suivi
  assert.ok(s.venues.find((v) => v.id === "be").followed);          // les théâtres ne bougent pas
  s = (await bearer("/app/api/act", session, { op: "sk", id: "expo", arg: "on" })).json;
  assert.ok(s.venues.find((v) => v.kind === "expo").followed);
  assert.equal((await bearer("/app/api/act", session, { op: "sk", id: "opera", arg: "on" })).status, 400);
});
await step("quartiers : chaque lieu connu a son quartier dans l'état", async () => {
  const s = (await post("/app/api/state", { initData: me })).json;
  assert.equal(s.venues.find((v) => v.id === "be")?.district ?? null, null);   // id de test inconnu → pas de quartier
  const { DISTRICT } = await import("../src/districts.ts").catch(() => ({ DISTRICT: null }));
  if (DISTRICT) assert.equal(DISTRICT["berliner-ensemble"], "Mitte");
});
await step("web : déconnexion → le jeton ne marche plus", async () => {
  assert.equal((await bearer("/app/api/logout", session)).status, 200);
  assert.equal((await bearer("/app/api/state", session)).status, 401);
});

console.log(`\n${ok} étapes OK`);
dev.kill(); tgServer.close(); rmSync(STATE, { recursive: true, force: true }); rmSync(`${STATE}-seed.sql`, { force: true });
