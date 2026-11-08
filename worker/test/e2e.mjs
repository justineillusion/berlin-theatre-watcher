// Test de bout en bout, 100 % local : wrangler dev (D1 local) + faux Telegram.
//   npm test
// Rejoue un scénario complet : inscription, invitation, scan, ⭐, ✅ + note +
// petit mot, 🔕, nouvelles dates, récap, /suivre, rappel expo.
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const TG_PORT = 8799, W_PORT = 8798;
const W = `http://127.0.0.1:${W_PORT}`;
const OWNER = 111, LEA = 222, MAX = 333, GROUP = -999;
const API = "test-api-token", HOOK = "test-hook";

// ---------------------------------------------------------------- faux Telegram
let calls = [], nextId = 1000;
const tgServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    calls.push({ method, ...JSON.parse(body || "{}") });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
  });
});
await new Promise((r) => tgServer.listen(TG_PORT, r));
const take = () => { const c = calls; calls = []; return c; };
const sends = (c, chat) => c.filter((x) => x.method === "sendMessage" && (chat === undefined || x.chat_id == chat));
const edits = (c, chat) => c.filter((x) => x.method === "editMessageText" && (chat === undefined || x.chat_id == chat));

// ---------------------------------------------------------------- worker local
rmSync(".wrangler/state", { recursive: true, force: true });
writeFileSync(".dev.vars",
  `BOT_TOKEN=x\nAPI_TOKEN=${API}\nWEBHOOK_SECRET=${HOOK}\nOWNER_CHAT_ID=${OWNER}\nBOT_USERNAME=TestBot\nTG_API=http://127.0.0.1:${TG_PORT}\n`);
execSync("npx wrangler d1 execute theatre-bot --local --file=schema.sql", { stdio: "ignore" });
const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(W_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
for (let i = 0; ; i++) {
  try { await fetch(W); break; } catch { if (i > 60) throw new Error("wrangler dev ne démarre pas\n" + devLog); }
  await new Promise((r) => setTimeout(r, 500));
}
const settle = () => new Promise((r) => setTimeout(r, 400));   // laisse finir les ctx.waitUntil

let upd = 1;
async function tgUpdate(update) {
  const r = await fetch(`${W}/tg`, {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": HOOK, "content-type": "application/json" },
    body: JSON.stringify({ update_id: upd++, ...update }),
  });
  assert.equal(r.status, 200);
  await settle();
  return take();
}
const user = (id) => ({ id, first_name: { [OWNER]: "Justine", [LEA]: "Léa", [MAX]: "Max" }[id], username: undefined });
const say = (id, text) => tgUpdate({ message: { message_id: upd, from: user(id), chat: { id, type: "private" }, text } });
const sayGroup = (id, text) => tgUpdate({ message: { message_id: upd, from: user(id), chat: { id: GROUP, type: "group" }, text } });
const click = (id, data, message_id, chatId = id, type = "private", text = "🎭 x") =>
  tgUpdate({ callback_query: { id: String(upd), from: user(id), data, message: { message_id, chat: { id: chatId, type }, text } } });

async function api(path, body) {
  const r = await fetch(`${W}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${API}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `${path} -> ${r.status} ${await r.clone().text()}`);
  return r.json();
}

// Simule le scraper Python : plan -> render -> « envoi » -> sent.
const VENUES = [
  { id: "berliner-ensemble", name: "Berliner Ensemble", kind: "theatre" },
  { id: "schaubuhne", name: "Schaubühne", kind: "theatre" },
  { id: "kw", name: "KW Institute for Contemporary Art", kind: "expo" },
];
async function scan(items, mode = "scan") {
  const p = await api("/api/plan", { mode, venues: VENUES, items, expo_last_weeks_days: 14 });
  const need = items.filter((i) => p.need.includes(i.id));
  const r = await api("/api/render", {
    mode, items: need.map((i) => ({ id: i.id, text: `🎭 <b>${i.title}</b>`, line: `• ${i.title}` })),
  });
  const sentList = r.messages.map((m) => {
    const { text, reply_markup, ...meta } = m;
    return { ...meta, message_id: nextId++ };
  });
  if (sentList.length) await api("/api/sent", { sent: sentList });
  return { need: p.need, messages: r.messages, sent: sentList };
}
const play = (id, title, dates, venue = "berliner-ensemble") =>
  ({ id, venue_id: venue, kind: "theatre", title, url: `https://x/${id}`, dates, start_date: null, end_date: null, starred: false });
const soon = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let ok = 0;
const step = async (name, fn) => {
  try { await fn(); ok++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n${e.stack}\n--- wrangler ---\n${devLog.slice(-3000)}`); dev.kill(); tgServer.close(); process.exit(1); }
};

try {
  console.log("Scénario :");
  const hedda = play("hedda0000001", "Hedda", ["2026-11-18 20:00"]);
  const ente = play("ente00000001", "Die Wildente", ["2026-11-20 19:30"], "schaubuhne");

  await step("inconnu sans invitation : refusé", async () => {
    const c = await say(MAX, "/start");
    assert.match(sends(c, MAX)[0].text, /pas \(ou plus\) valable/);
  });

  await step("la propriétaire s'inscrit sans code", async () => {
    await scan([]);                                   // crée les lieux
    const c = await say(OWNER, "/start");
    assert.match(sends(c, OWNER)[0].text, /Bienvenue Justine/);
  });

  await step("1er scan : catalogue enregistré EN SILENCE (pas de spam)", async () => {
    const s = await scan([hedda, ente]);
    assert.equal(s.messages.length, 0);
  });

  let code;
  await step("/invite donne un lien t.me, Léa rejoint avec", async () => {
    const c = await say(OWNER, "/invite");
    code = sends(c, OWNER)[0].text.match(/start=(\w+)/)[1];
    const j = await say(LEA, `/start ${code}`);
    assert.match(sends(j, LEA)[0].text, /Bienvenue Léa/);
    assert.match(sends(j, OWNER)[0].text, /Léa a rejoint/);
  });

  await step("/groupe dans un groupe : annonces activées", async () => {
    const c = await sayGroup(OWNER, "/groupe@TestBot");
    assert.equal(sends(c, GROUP).length, 1);
  });

  const lear = play("lear00000001", "King Lear", ["2026-12-01 19:30"]);
  let msgs;
  await step("nouvelle pièce : chacun la reçoit avec ⭐ ✅ 🔕", async () => {
    await scan([hedda, ente]);                        // amorce Léa
    const s = await scan([hedda, ente, lear]);
    msgs = Object.fromEntries(s.sent.map((m) => [m.chat_id, m.message_id]));
    assert.deepEqual(s.messages.map((m) => m.chat_id).sort(), [OWNER, LEA].sort());
    const kb = s.messages[0].reply_markup.inline_keyboard[0].map((b) => b.text);
    assert.deepEqual(kb, ["⭐ Intéressé·e", "✅ Vu", "🔕 Ignorer"]);
  });

  await step("Léa ⭐ : sa notif + celle de Justine affichent « Intéressé·es : Léa », annonce au groupe", async () => {
    const c = await click(LEA, "i:lear00000001", msgs[LEA]);
    assert.match(edits(c, LEA)[0].text, /Intéressé·es : toi/);
    assert.match(edits(c, OWNER)[0].text, /Intéressé·es : Léa/);
    assert.match(sends(c, GROUP)[0].text, /Léa<\/b> est intéressé·e par/);
  });

  await step("Justine clique « Moi aussi » dans le groupe", async () => {
    const c = await click(OWNER, "i:lear00000001", 5555, GROUP, "group");
    const g = edits(c, GROUP)[0];
    assert.match(g.text, /Intéressé·es : Léa, Justine/);
    assert.match(edits(c, OWNER)[0].text, /Intéressé·es : Léa, toi/);
  });

  await step("/interets liste ce qui tente la bande", async () => {
    const c = await say(LEA, "/interets");
    assert.match(sends(c, LEA)[0].text, /King Lear[\s\S]*⭐ Justine, <b>toi<\/b>|King Lear[\s\S]*⭐ <b>toi<\/b>, Justine/);
  });

  await step("Léa ✅ Vu → note 4★ → petit mot : partagé à la bande et au groupe", async () => {
    let c = await click(LEA, "v:lear00000001", msgs[LEA]);
    assert.equal(edits(c, LEA)[0].reply_markup.inline_keyboard[0].length, 5);   // 1★…5★
    c = await click(LEA, "r:lear00000001:4", msgs[LEA]);
    assert.match(sends(c, LEA)[0].text, /Un petit mot/);
    assert.match(sends(c, GROUP)[0].text, /Léa<\/b> a vu .* ★★★★☆/);
    c = await say(LEA, "Bouleversant, Lars Eidinger incroyable");
    assert.match(sends(c, GROUP)[0].text, /« Bouleversant/);
    assert.match(edits(c, OWNER)[0].text, /✅ Léa ★★★★☆ — « Bouleversant/);
  });

  await step("Justine 🔕 Ignorer Hedda", async () => {
    const c = await click(OWNER, "x:hedda0000001", 4242);
    assert.match(edits(c, OWNER)[0].text, /Ignoré/);
  });

  await step("nouvelles dates : seulement à qui n'a ni vu ni ignoré", async () => {
    const s = await scan([
      { ...hedda, dates: [...hedda.dates, "2026-12-10 20:00"] },
      ente,
      { ...lear, dates: [...lear.dates, "2026-12-15 19:30"] },
    ]);
    // Hedda : Justine ignore → Léa seule. Lear : Léa a vu → Justine seule.
    const got = s.messages.map((m) => `${m.chat_id}:${m.item_id}`).sort();
    assert.deepEqual(got, [`${LEA}:hedda0000001`, `${OWNER}:lear00000001`].sort());
    assert.match(s.messages.find((m) => m.chat_id === OWNER).text, /🆕 <b>Nouvelles dates<\/b> : 15\/12/);
  });

  await step("le même scan rejoué : rien (idempotent)", async () => {
    const s = await scan([{ ...hedda, dates: [...hedda.dates, "2026-12-10 20:00"] }, ente,
      { ...lear, dates: [...lear.dates, "2026-12-15 19:30"] }]);
    assert.equal(s.messages.length, 0);
  });

  await step("/suivre : Léa décoche la Schaubühne → plus rien de là-bas", async () => {
    let c = await say(LEA, "/suivre");
    const kb = sends(c, LEA)[0].reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(kb.some((t) => t.startsWith("✅ 🎭 Schaubühne")));
    c = await click(LEA, "s:schaubuhne", 7777);
    const kb2 = c.find((x) => x.method === "editMessageReplyMarkup").reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(kb2.some((t) => t.startsWith("⬜️ 🎭 Schaubühne")));
    const s = await scan([hedda, ente, lear, play("orest0000001", "Orestie", ["2027-01-05 19:00"], "schaubuhne")]);
    assert.deepEqual(s.messages.map((m) => m.chat_id), [OWNER]);
  });

  await step("récap : par personne, sans le vu/ignoré, avec la ligne 👥", async () => {
    const s = await scan([hedda, ente, lear], "digest");
    const j = s.messages.filter((m) => m.chat_id === OWNER).map((m) => m.text).join("\n");
    const l = s.messages.filter((m) => m.chat_id === LEA).map((m) => m.text).join("\n");
    assert.doesNotMatch(j, /Hedda/);               // ignorée par Justine
    assert.match(j, /King Lear\n   👥 ⭐ toi · ✅ ★★★★☆ \(1 avis\)/);
    assert.doesNotMatch(l, /King Lear/);           // vue par Léa
    assert.doesNotMatch(l, /Wildente/);            // Schaubühne décochée
  });

  await step("/ignores → ↩️ réactive Hedda", async () => {
    let c = await say(OWNER, "/ignores");
    const m = sends(c, OWNER)[0];
    assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, "u:hedda0000001");
    // Telegram renvoie le texte SANS balises HTML dans callback_query.message.
    c = await click(OWNER, "u:hedda0000001", 8888, OWNER, "private", m.text.replace(/<[^>]+>/g, ""));
    assert.ok(c.some((x) => x.method === "editMessageReplyMarkup"));
    c = await say(OWNER, "/ignores");
    assert.match(sends(c, OWNER)[0].text, /n'ignores rien/);
  });

  await step("expo : notif à l'annonce, puis rappel « dernières semaines » si ⭐", async () => {
    const expo = { id: "expo00000001", venue_id: "kw", kind: "expo", title: "Susan Hiller — Bad Dreams",
      url: "https://kw/x", dates: [], start_date: "", end_date: soon(60), starred: false };
    const old = { ...expo, id: "expo00000000", title: "Déjà là" };
    let s = await scan([hedda, ente, lear, old]);  // 1re fois qu'on voit des expos KW : amorçage
    assert.equal(s.messages.length, 0);
    s = await scan([hedda, ente, lear, old, expo]);
    assert.deepEqual(s.messages.map((m) => m.chat_id).sort(), [OWNER, LEA].sort());
    assert.equal(s.messages[0].reply_markup.inline_keyboard[0][1].text, "✅ Vue");
    const leaMsg = s.sent.find((m) => m.chat_id === LEA).message_id;
    await click(LEA, "i:expo00000001", leaMsg);
    s = await scan([hedda, ente, lear, old, { ...expo, end_date: soon(10) }]);
    assert.deepEqual(s.messages.map((m) => `${m.chat_id}:${m.kind}`), [`${LEA}:last_weeks`]);
    assert.match(s.messages[0].text, /Dernières semaines/);
    s = await scan([hedda, ente, lear, old, { ...expo, end_date: soon(10) }]);
    assert.equal(s.messages.length, 0);            // un seul rappel
  });

  await step("/programme, /vus, /aide répondent", async () => {
    assert.match(sends(await say(LEA, "/programme"), LEA)[0].text, /À l'affiche/);
    assert.match(sends(await say(LEA, "/vus"), LEA)[0].text, /King Lear.*★★★★☆/);
    assert.match(sends(await say(OWNER, "/aide"), OWNER)[0].text, /Admin/);
  });

  await step("/nouveaulien invalide l'ancien lien", async () => {
    await say(OWNER, "/nouveaulien");
    assert.match(sends(await say(MAX, `/start ${code}`), MAX)[0].text, /pas \(ou plus\) valable/);
  });

  await step("sécurité : webhook sans secret et API sans token refusés", async () => {
    assert.equal((await fetch(`${W}/tg`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${W}/api/plan`, { method: "POST", body: "{}" })).status, 401);
  });

  console.log(`\n✅ ${ok} étapes OK`);
} finally {
  dev.kill();
  tgServer.close();
  rmSync(".dev.vars", { force: true });
}
