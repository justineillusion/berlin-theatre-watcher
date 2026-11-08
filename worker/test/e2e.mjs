// Test de bout en bout, 100 % local : wrangler dev (D1 local) + faux Telegram.
//   npm test
// Rejoue un scénario complet : inscription, invitation, scan, ⭐, ✅ + note +
// petit mot, 🔕, nouvelles dates, récap, /suivre, rappel expo, cinémas.
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
const allCalls = [];
const tgServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    calls.push({ method, ...JSON.parse(body || "{}"), _id: nextId });
    allCalls.push(calls[calls.length - 1]);
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
// Les scénarios historiques reçoivent les fiches tout de suite ; le lot du matin a son étape.
const sql = (q) => execSync(`npx wrangler d1 execute theatre-bot --local --json --command "${q}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('immediate_cards', '1')");
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
const say = (id, text, replyTo) => tgUpdate({ message: { message_id: upd, from: user(id), chat: { id, type: "private" }, text,
  ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
const sayGroup = (id, text) => tgUpdate({ message: { message_id: upd, from: user(id), chat: { id: GROUP, type: "group" }, text } });
const click = (id, data, message_id, chatId = id, type = "private", text = "🎭 x") =>
  tgUpdate({ callback_query: { id: String(upd), from: user(id), data, message: { message_id, chat: { id: chatId, type }, text } } });

async function api(path, body) {
  // Les fixtures datent de tous les mois : horizon large par défaut (testé à part).
  if (path === "/api/plan") body = { horizon_expo_days: 3650, horizon_theatre_days: 3650, ...body };
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
    mode, items: need.map((i) => ({
      id: i.id, text: `🎭 <b>${i.title}</b>`, line: `• ${i.title}`,
      ...(p.langs?.includes("en") ? { text_en: `🎭 <b>${i.title}</b> [EN]`, line_en: `• ${i.title} [EN]` } : {}),
    })),
  });
  const sentList = r.messages.map((m) => {
    const { text, reply_markup, ...meta } = m;
    return { ...meta, message_id: nextId++ };
  });
  if (sentList.length) await api("/api/sent", { sent: sentList });
  return { need: p.need, langs: p.langs, messages: r.messages, sent: sentList };
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
    assert.deepEqual(kb, ["⭐ Intéressé·e", "🙅 Pas pour moi", "✅ Déjà vu"]);   // proposé, à l'affiche
  });

  await step("Léa ⭐ : sa notif + celle de Justine affichent « Intéressé·es : Léa », annonce au groupe", async () => {
    const c = await click(LEA, "i:lear00000001", msgs[LEA]);
    assert.match(edits(c, LEA)[0].text, /Intéressé·es : toi/);
    assert.match(edits(c, OWNER)[0].text, /Intéressé·es : Léa/);
    const g = sends(c, GROUP)[0];
    assert.match(g.text, /^⭐ <b>Léa<\/b> est intéressé·e\n\n🎭 <b>King Lear<\/b>/);   // en-tête + fiche commune
    assert.deepEqual(g.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["i:lear00000001", "v:lear00000001"]);
  });

  await step("Justine clique « Moi aussi » dans le groupe → l'annonce devient « 🎟 Plan ! »", async () => {
    const c = await click(OWNER, "i:lear00000001", 5555, GROUP, "group", "⭐ Léa est intéressé·e par King Lear");
    const g = edits(c, GROUP)[0];
    assert.match(g.text, /^🎟 <b>Plan !<\/b> Léa et Justine veulent y aller\n\n🎭 <b>King Lear<\/b>/);
    assert.deepEqual(g.reply_markup.inline_keyboard[0].map((b) => b.text), ["🙋 Moi aussi", "✅ Je l'ai vu aussi"]);
    assert.match(edits(c, OWNER)[0].text, /Intéressé·es : Léa, toi/);
  });

  await step("groupe : /interets@bot, /programme, /aide répondent dans le groupe", async () => {
    let c = await sayGroup(LEA, "/interets@TestBot");
    assert.match(sends(c, GROUP)[0].text, /King Lear[\s\S]*⭐ Léa, Justine/);
    c = await sayGroup(LEA, "/programme@TestBot");
    const p = sends(c, GROUP)[0];
    assert.match(p.text, /À l'affiche dans nos lieux[\s\S]*Hedda/);
    assert.ok(p.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "i:hedda0000001"));
    c = await sayGroup(LEA, "/aide");
    assert.match(sends(c, GROUP)[0].text, /dans le groupe/);
  });

  await step("groupe : un non-membre qui clique ⭐ est envoyé vers le bot (lien d'invitation)", async () => {
    const c = await tgUpdate({ callback_query: { id: "nm", from: { id: 777, first_name: "Zed" }, data: "i:lear00000001",
      message: { message_id: 5555, chat: { id: GROUP, type: "group" }, text: "⭐ x" } } });
    assert.match(c.find((x) => x.method === "answerCallbackQuery").url, /t\.me\/TestBot\?start=\w+/);
  });

  await step("/sorties (alias /interets) : mes ⭐ avec qui d'autre y va, boutons 🎟 ✅ ✖", async () => {
    for (const cmd of ["/sorties", "/interets"]) {
      const m = sends(await say(LEA, cmd), LEA)[0];
      assert.match(m.text, /^🗂 <b>Mes sorties<\/b>\n\n⭐ <b>Intéressé·e<\/b>\n🎭 <a[^>]*>King Lear<\/a> — <i>Berliner Ensemble<\/i> · ⭐$/);
      assert.deepEqual(m.reply_markup.inline_keyboard[0], [{ text: "🎭 King Lear · ⭐", callback_data: "lo:lear00000001" }]);
    }
  });

  await step("Léa ✅ Vu → note 4★ → petit mot : partagé à la bande et au groupe", async () => {
    let c = await click(LEA, "v:lear00000001", msgs[LEA]);
    assert.equal(edits(c, LEA)[0].reply_markup.inline_keyboard[0].length, 5);   // 1★…5★
    c = await click(LEA, "r:lear00000001:4", msgs[LEA]);
    // noté : la fiche ne propose plus que [✍️ Critique] ; plus d'invitation automatique
    assert.deepEqual(edits(c, LEA).find((x) => x.message_id === msgs[LEA]).reply_markup.inline_keyboard,
      [[{ text: "✍️ Critique", callback_data: "w:lear00000001" }]]);
    assert.ok(!sends(c, LEA).some((m) => m.reply_markup?.force_reply));
    const review = sends(c, GROUP)[0];
    assert.match(review.text, /^✅ <b>Léa<\/b> a vu\n★★★★☆ 4\/5\n\n🎭 <b>King Lear<\/b>/);
    assert.deepEqual(review.reply_markup.inline_keyboard[0].map((b) => b.text), ["🙋 Moi aussi", "✅ Je l'ai vu aussi"]);
    const w = await click(LEA, "w:lear00000001", msgs[LEA]);
    assert.match(sends(w, LEA)[0].text, /★★★★☆ pour <b>King Lear<\/b>[\s\S]*Un petit mot/);
    c = await say(LEA, "Bouleversant, Lars Eidinger incroyable");
    // avis donné : la fiche montre note + avis, et seulement [✏️ Modifier]
    assert.deepEqual(edits(c, LEA).find((x) => x.message_id === msgs[LEA]).reply_markup.inline_keyboard,
      [[{ text: "✏️ Modifier", callback_data: "ed:lear00000001" }]]);
    // le petit mot COMPLÈTE l'avis déjà posté (édition, pas de 2e message)
    assert.equal(sends(c, GROUP).length, 0);
    assert.match(edits(c, GROUP)[0].text, /★★★★☆ 4\/5\n💬 “Bouleversant, Lars Eidinger incroyable”/);
    assert.match(edits(c, OWNER)[0].text, /✅ Léa ★★★★☆ — « Bouleversant/);
  });

  await step("deux notes coup sur coup, réponses dans l'ordre inverse : chaque avis va au bon item", async () => {
    // Deux pièces notées à la suite : deux invitations force_reply ouvertes.
    const A = play("rvA000000001", "Hedda Gabler", ["2026-12-20 19:30"]);
    const B = play("rvB000000001", "Die Möwe", ["2026-12-21 19:30"]);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, A, B] });
    let c = await click(LEA, "v:rvA000000001", 7001);
    c = await click(LEA, "r:rvA000000001:5", 7001);
    c = await click(LEA, "w:rvA000000001", 7001);
    const p1 = sends(c, LEA).find((m) => m.reply_markup?.force_reply);
    assert.equal(p1.reply_markup.input_field_placeholder, "Ton avis sur Hedda Gabler…");
    c = await click(LEA, "v:rvB000000001", 7002);
    c = await click(LEA, "r:rvB000000001:3", 7002);
    c = await click(LEA, "w:rvB000000001", 7002);
    const p2 = sends(c, LEA).find((m) => m.reply_markup?.force_reply);
    assert.match(p2.text, /Die Möwe/);
    // réponse à la 1re invitation d'abord (ordre inverse) → Hedda
    // l'avis met à jour LA fiche (« ✅ Vu · ★★★★★ · « … » ») ; invitation et réponse supprimées
    c = await say(LEA, "Gabler : magistral", p1._id);
    assert.match(edits(c, LEA).find((x) => x.message_id === 7001).text, /Vu · ★★★★★ · « Gabler : magistral »/);
    assert.ok(c.some((x) => x.method === "deleteMessage" && x.message_id === p1._id));
    assert.ok(c.some((x) => x.method === "deleteMessage" && x.chat_id === LEA && x.message_id !== p1._id));
    assert.equal(sends(c, LEA).length, 0);                          // pas de nouveau message
    // puis texte libre sans « répondre » → l'invitation ouverte restante (Möwe)
    c = await say(LEA, "Möwe : un peu long");
    assert.match(edits(c, LEA).find((x) => x.message_id === 7002).text, /Vu · ★★★☆☆ · « Möwe : un peu long »/);
    const vus = sends(await say(LEA, "/vus"), LEA)[0].text;
    assert.match(vus, /Hedda Gabler[\s\S]*magistral/);
    assert.match(vus, /Möwe[\s\S]*un peu long/);
    // ✍️ sur une fiche vue : rouvre une invitation pour CET item ; /passer la ferme
    c = await click(LEA, "w:rvA000000001", 7001);
    const p3 = sends(c, LEA).find((m) => m.reply_markup?.force_reply);
    assert.match(p3.text, /Hedda Gabler/);
    await say(LEA, "/passer");
    c = await say(LEA, "texte perdu ?");
    assert.doesNotMatch(sends(c, LEA)[0].text, /Avis enregistré/);
    // noté + avis : [✏️ Modifier] → 1–5★ (note actuelle marquée) + réécrire + ↩︎, sur place
    c = await click(LEA, "ed:rvA000000001", 7001);
    assert.equal(sends(c, LEA).length, 0);
    const ek = edits(c, LEA).find((x) => x.message_id === 7001);
    assert.match(ek.text, /Vu · ★★★★★ · « Gabler : magistral »/);
    assert.deepEqual(ek.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)),
      [["1★", "2★", "3★", "4★", "· 5★ ·"], ["✍️ Réécrire la critique", "↩︎ Retour"]]);
    c = await click(LEA, "eb:rvA000000001", 7001);
    assert.deepEqual(edits(c, LEA).find((x) => x.message_id === 7001).reply_markup.inline_keyboard,
      [[{ text: "✏️ Modifier", callback_data: "ed:rvA000000001" }]]);
    // changer la note : la fiche suit, le groupe n'est PAS ré-annoncé
    c = await click(LEA, "r:rvA000000001:3", 7001);
    assert.match(edits(c, LEA).find((x) => x.message_id === 7001).text, /Vu · ★★★☆☆ · « Gabler : magistral »/);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(sends(c, GROUP).length, 0);
    await say(LEA, "/passer");
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear] });
  });

  await step("Justine 🔕 Ignorer Hedda", async () => {
    const c = await click(OWNER, "x:hedda0000001", 4242);
    assert.match(edits(c, OWNER)[0].text, /🙅 <i>Pas pour moi<\/i>/);
    assert.deepEqual(edits(c, OWNER)[0].reply_markup.inline_keyboard, [[{ text: "↩︎ Annuler", callback_data: "u:hedda0000001" }]]);
  });

  await step("nouvelles dates : seulement à qui n'a ni vu, ni ignoré, ni déjà ⭐", async () => {
    const s = await scan([
      { ...hedda, dates: [...hedda.dates, "2026-12-10 20:00"] },
      ente,
      { ...lear, dates: [...lear.dates, "2026-12-15 19:30"] },
    ]);
    // Hedda : Justine ignore → Léa seule (fiche). Lear : Léa a vu → rien ; Justine l'a ⭐ → des dates
    // pour une ⭐ = réserver maintenant : message compact immédiat, avec le lien 🎟.
    const got = s.messages.filter((m) => m.item_id).map((m) => `${m.chat_id}:${m.item_id}`).sort();
    assert.deepEqual(got, [`${LEA}:hedda0000001`]);
    assert.match(s.messages.find((m) => m.item_id).text, /🆕 <b>Nouvelles dates<\/b> : 10\/12/);
    const urgent = s.messages.filter((m) => m.kind === "urgent");
    assert.deepEqual(urgent.map((m) => m.chat_id), [OWNER]);
    assert.equal(urgent[0].text,
      `🎟 <b>Nouvelles dates pour tes ⭐</b>\n🎟 <a href="https://x/lear00000001">King Lear</a> <i>(Berliner Ensemble)</i> : 15/12 19:30`);
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

  await step("récap : par personne, sans le vu / ignoré / déjà ⭐, avec la ligne 👥", async () => {
    const s = await scan([hedda, ente, lear], "digest");
    const j = s.messages.filter((m) => m.chat_id === OWNER).map((m) => m.text).join("\n");
    const l = s.messages.filter((m) => m.chat_id === LEA).map((m) => m.text).join("\n");
    assert.doesNotMatch(j, /Hedda/);               // ignorée par Justine
    assert.doesNotMatch(j, /King Lear/);           // déjà ⭐ par Justine : dans /interets, pas reproposée
    assert.match(j, /Die Wildente/);
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
    assert.match(sends(c, OWNER)[0].text, /Rien en « Pas pour moi »/);
  });

  await step("expo : notif à l'annonce, puis rappel « dernières semaines » si ⭐", async () => {
    const expo = { id: "expo00000001", venue_id: "kw", kind: "expo", title: "Susan Hiller — Bad Dreams",
      url: "https://kw/x", dates: [], start_date: "", end_date: soon(60), starred: false };
    const old = { ...expo, id: "expo00000000", title: "Déjà là" };
    let s = await scan([hedda, ente, lear, old]);  // 1re fois qu'on voit des expos KW : amorçage
    assert.equal(s.messages.length, 0);
    s = await scan([hedda, ente, lear, old, expo]);
    assert.deepEqual(s.messages.map((m) => m.chat_id).sort(), [OWNER, LEA].sort());
    assert.equal(s.messages[0].reply_markup.inline_keyboard[0][2].text, "✅ Déjà vu");   // expo ouverte
    const leaMsg = s.sent.find((m) => m.chat_id === LEA).message_id;
    await click(LEA, "i:expo00000001", leaMsg);
    s = await scan([hedda, ente, lear, old, { ...expo, end_date: soon(10) }]);
    assert.deepEqual(s.messages.map((m) => `${m.chat_id}:${m.kind}`), [`${LEA}:last_weeks`]);
    assert.match(s.messages[0].text, /Dernières semaines/);
    s = await scan([hedda, ente, lear, old, { ...expo, end_date: soon(10) }]);
    assert.equal(s.messages.length, 0);            // un seul rappel
  });

  await step("/programme, /vus, /aide répondent", async () => {
    assert.match(sends(await say(LEA, "/programme"), LEA)[0].text, /^📅 <b>À l'affiche<\/b> \(\d+\)/);
    assert.match(sends(await say(LEA, "/vus"), LEA)[0].text, /King Lear.*★★★★☆/);
    assert.match(sends(await say(OWNER, "/aide"), OWNER)[0].text, /Admin/);
  });

  await step("/nouveaulien invalide l'ancien lien", async () => {
    await say(OWNER, "/nouveaulien");
    assert.match(sends(await say(MAX, `/start ${code}`), MAX)[0].text, /pas \(ou plus\) valable/);
  });

  // ------------------------------------------------------------ ciné du lundi
  const CINEMAS = [
    { id: "cinema-intimes", name: "Intimes" },
    { id: "cinema-lichtblick", name: "Lichtblick" },
    { id: "cinema-babylon", name: "Babylon" },
  ];
  const cine = async (venues = CINEMAS) => (await api("/api/cinema-recipients", { venues })).recipients;
  const byChat = (rs) => Object.fromEntries(rs.map((r) => [r.chat_id, [...r.venue_ids].sort()]));
  const ALL_CINE = CINEMAS.map((c) => c.id).sort();
  const suivre = async (id) => sends(await say(id, "/suivre"), id)[0].reply_markup.inline_keyboard.flat().map((b) => b.text);

  await step("ciné : cinémas enregistrés ; qui suivait tout y est abonné d'office, pas Léa", async () => {
    const r = byChat(await cine());
    assert.deepEqual(r, { [OWNER]: ALL_CINE });       // Léa a décoché la Schaubühne : pas « tout »
  });

  await step("ciné : le scan théâtre ne désactive pas les cinémas (ni l'inverse)", async () => {
    await scan([hedda, ente, lear]);
    let kb = await suivre(LEA);
    const order = kb.filter((t) => /[🎭🖼🎬]/u.test(t)).map((t) => t.split(" ")[1]);
    assert.deepEqual(order, ["🎭", "🎭", "🖼", "🎬", "🎬", "🎬"]);   // théâtres, expos, cinémas
    assert.ok(kb.includes("⬜️ 🎬 Intimes"));
    await cine(CINEMAS.slice(0, 2));                   // Babylon retiré de cinema.yaml
    kb = await suivre(LEA);
    assert.ok(kb.some((t) => t.includes("Berliner Ensemble")) && kb.some((t) => t.includes("KW")));
    assert.ok(!kb.some((t) => t.includes("Babylon")));
    assert.deepEqual(byChat(await cine(CINEMAS.slice(0, 2))), { [OWNER]: ALL_CINE.filter((x) => x !== "cinema-babylon") });
    assert.deepEqual(await cine([]), []);              // config vide : ne touche à rien
    assert.deepEqual(byChat(await cine()), { [OWNER]: ALL_CINE });   // Babylon revient, abonnement intact
  });

  await step("ciné : Léa coche l'Intimes dans /suivre → digest pour ce cinéma seulement", async () => {
    const c = await click(LEA, "s:cinema-intimes", 7778);
    const kb = c.find((x) => x.method === "editMessageReplyMarkup").reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(kb.includes("✅ 🎬 Intimes"));
    assert.deepEqual(byChat(await cine()), { [OWNER]: ALL_CINE, [LEA]: ["cinema-intimes"] });
    await click(OWNER, "s:cinema-babylon", 7779);      // la propriétaire décoche le Babylon
    assert.deepEqual(byChat(await cine())[OWNER], ["cinema-intimes", "cinema-lichtblick"]);
  });

  await step("ciné : un nouvel ami suit tous les cinémas par défaut ; /aide en parle", async () => {
    const link = sends(await say(OWNER, "/invite"), OWNER)[0].text.match(/start=(\w+)/)[1];
    await say(MAX, `/start ${link}`);
    assert.deepEqual(byChat(await cine())[MAX], ALL_CINE);
    assert.match(sends(await say(MAX, "/aide"), MAX)[0].text, /films de la semaine/);
    await click(MAX, "sn", 7780);                      // « Rien » : plus de digest ciné
    assert.equal(byChat(await cine())[MAX], undefined);
  });

  await step("ciné : une fois par semaine (2e créneau cron = rien), sauf force", async () => {
    const body = { venues: CINEMAS, week: "2026-11-09" };
    assert.ok((await api("/api/cinema-recipients", body)).recipients.length > 0);
    await api("/api/cinema-done", { week: "2026-11-09" });
    const again = await api("/api/cinema-recipients", body);
    assert.equal(again.already_sent, true);
    assert.deepEqual(again.recipients, []);
    assert.ok((await api("/api/cinema-recipients", { ...body, force: true })).recipients.length > 0);
    assert.ok((await api("/api/cinema-recipients", { ...body, week: "2026-11-16" })).recipients.length > 0);
  });

  // ------------------------------------------------------------ langue
  await step("/langue : Léa passe en anglais (boutons 🇫🇷 / 🇬🇧)", async () => {
    let c = await say(LEA, "/langue");
    const kb = sends(c, LEA)[0].reply_markup.inline_keyboard[0].map((b) => b.callback_data);
    assert.deepEqual(kb, ["l:fr", "l:en"]);
    c = await click(LEA, "l:en", 9001);
    // menu « / » de CE chat en anglais (Telegram suit sinon la langue de l'appli)
    const menu = c.find((x) => x.method === "setMyCommands" && x.scope?.type === "chat" && x.scope.chat_id === LEA);
    assert.ok(menu && menu.commands.length === 3 && /What's on/.test(menu.commands[0].description), "menu par chat en anglais");
    assert.deepEqual(menu.commands.map((m) => m.command), ["programme", "sorties", "reglages"]);
    assert.ok(allCalls.some((x) => x.method === "setMyCommands" && x.scope?.type === "all_group_chats"), "menus globaux reposés");
    assert.match(edits(c, LEA)[0].text, /English/);
    assert.match(sends(await say(LEA, "/aide"), LEA)[0].text, /How it works[\s\S]*\/reglages — venues, language/);
    assert.match(sends(await say(LEA, "/suivre"), LEA)[0].text, /What do you want to follow/);
    assert.match(sends(await say(OWNER, "/aide"), OWNER)[0].text, /Comment ça marche/);   // Justine reste en français
  });

  await step("langue : notif rendue en anglais pour Léa, en français pour Justine", async () => {
    const peer = play("peer00000001", "Peer Gynt", ["2027-02-01 19:00"]);
    const s = await scan([hedda, ente, lear, peer]);
    assert.ok(s.langs.includes("en"));
    const lea = s.messages.find((m) => m.chat_id === LEA), jus = s.messages.find((m) => m.chat_id === OWNER);
    assert.match(lea.text, /Peer Gynt<\/b> \[EN\]/);
    assert.deepEqual(lea.reply_markup.inline_keyboard[0].map((b) => b.text), ["⭐ Interested", "🙅 Not for me", "✅ Already seen"]);
    assert.doesNotMatch(jus.text, /\[EN\]/);
    assert.equal(jus.reply_markup.inline_keyboard[0][0].text, "⭐ Intéressé·e");
    // Léa ⭐ : toast et sa notif en anglais, l'annonce du groupe dans la langue du groupe (fr)
    const c = await click(LEA, "i:peer00000001", s.sent.find((m) => m.chat_id === LEA).message_id);
    assert.match(edits(c, LEA)[0].text, /Interested: you/);
    assert.match(edits(c, OWNER)[0].text, /Intéressé·es : Léa/);
    assert.match(sends(c, GROUP)[0].text, /est intéressé·e\n\n🎭 <b>Peer Gynt<\/b>/);   // groupe en fr : fiche fr
    assert.equal(c.find((x) => x.method === "answerCallbackQuery").text, "⭐ Noted, the gang knows");
  });

  await step("langue : récap du dimanche et /programme en anglais", async () => {
    const s = await scan([hedda, ente, lear], "digest");
    const l = s.messages.filter((m) => m.chat_id === LEA).map((m) => m.text).join("\n");
    assert.match(l, /Sunday round-up/);
    assert.match(l, /• Hedda \[EN\]/);
    assert.match(sends(await say(LEA, "/programme"), LEA)[0].text, /^📅 <b>What's on<\/b> \(\d+\)/);
  });

  await step("langue : à l'inscription, choix proposé ; 🇬🇧 redonne l'accueil en anglais", async () => {
    const ZOE = 444;
    const link = sends(await say(OWNER, "/invite"), OWNER)[0].text.match(/start=(\w+)/)[1];
    let c = await tgUpdate({ message: { message_id: upd, from: { id: ZOE, first_name: "Zoé" }, chat: { id: ZOE, type: "private" }, text: `/start ${link}` } });
    const last = sends(c, ZOE).at(-1);
    assert.deepEqual(last.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["l:fr:1", "l:en:1"]);
    c = await tgUpdate({ callback_query: { id: "z1", from: { id: ZOE, first_name: "Zoé" }, data: "l:en:1", message: { message_id: 1, chat: { id: ZOE, type: "private" }, text: "x" } } });
    assert.match(sends(c, ZOE)[0].text, /Welcome Zoé[\s\S]*How it works/);
    assert.match(sends(c, ZOE)[1].text, /By default you follow everything/);
    const r = (await cine()).find((x) => x.chat_id === ZOE);
    assert.equal(r.lang, "en");
    assert.equal((await cine()).find((x) => x.chat_id === OWNER).lang, "fr");
  });

  await step("langue : inconnu avec une appli en anglais → refus en anglais", async () => {
    const c = await tgUpdate({ message: { message_id: upd, from: { id: 555, first_name: "Bob", language_code: "en" }, chat: { id: 555, type: "private" }, text: "/start nope" } });
    assert.match(sends(c, 555)[0].text, /isn't valid/);
  });

  // ------------------------------------------------------------ groupe (suite)
  await step("groupe : « ✅ Je l'ai vu aussi » → note en privé, avis posté en réponse dans le groupe", async () => {
    let c = await click(OWNER, "v:peer00000001", 6000, GROUP, "group", "✅ Léa a vu");
    assert.equal(c.find((x) => x.method === "answerCallbackQuery").text, "Regarde ton chat privé avec le bot ✉️");
    const dm = sends(c, OWNER)[0];
    assert.match(dm.text, /Ta note pour la bande/);
    assert.equal(dm.reply_markup.inline_keyboard[0].length, 5);
    c = await click(OWNER, "r:peer00000001:5", 6001);
    const g = c.find((x) => x.method === "sendMessage" && x.chat_id == GROUP);
    assert.match(g.text, /Justine<\/b> a vu[\s\S]*★★★★★ 5\/5/);
    assert.equal(g.reply_parameters.message_id, 6000);
    await say(OWNER, "/passer");
  });

  await step("récap du dimanche : le groupe reçoit « le plan de la semaine »", async () => {
    const s = await scan([hedda, ente, lear], "digest");
    const g = s.messages.filter((m) => m.chat_id === GROUP).map((m) => m.text).join("\n");
    assert.match(g, /plan de la semaine/);
  });

  await step("/programme : UNE liste dépliable — filtre [Tout] [🎭] [🖼] [🎬], 8 par page, fiche sur place", async () => {
    let c = await say(OWNER, "/programme");
    const menu = sends(c, OWNER)[0];
    assert.equal(sends(c, OWNER).length, 1);                              // un seul message
    const kb = menu.reply_markup.inline_keyboard;
    assert.deepEqual(kb[0].map((b) => b.callback_data), ["lf:all", "lf:theatre", "lf:expo", "lf:film"]);
    assert.deepEqual(kb[0].map((b) => b.text), ["· Tout ·", "🎭", "🖼", "🎬"]);
    assert.match(menu.text, /^📅 <b>À l'affiche<\/b> \(\d+\)\n\n🎭 <b>THÉÂTRE<\/b>\n🎭 <a[^>]*>[^<]+<\/a> — <i>[^<]+<\/i>/);
    // un item se déplie dans ce message : boutons d'état + ↩︎ Liste ; ↩︎ revient au filtre et à la page
    const first = kb.find((r) => r[0].callback_data.startsWith("lo:"))[0];
    c = await click(OWNER, first.callback_data, menu._id);
    assert.equal(sends(c, OWNER).length, 0);
    const card = edits(c, OWNER).find((x) => x.message_id === menu._id);
    assert.deepEqual(card.reply_markup.inline_keyboard.at(-1), [{ text: "↩︎ Liste", callback_data: "lb" }]);
    c = await click(OWNER, "lb", menu._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === menu._id).reply_markup.inline_keyboard[0][0].text, "· Tout ·");
    // pagination : assez de pièces → [◀] [1/n] [▶]
    const extra = Array.from({ length: 9 }, (_, n) => play(`page000000${String(n).padStart(2, "0")}`, `Pièce ${n + 1}`, [`2027-0${(n % 9) + 1}-10 19:00`]));
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, ...extra] });
    const p1 = sends(await say(OWNER, "/programme"), OWNER)[0];
    assert.match(p1.reply_markup.inline_keyboard.at(-1)[1].text, /^1\/\d+$/);
    assert.equal(p1.reply_markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith("lo:")).length, 8);
    // filtre 🖼 : seulement des expos, page 1
    c = await click(OWNER, "lf:expo", p1._id);
    const ex = edits(c, OWNER).find((x) => x.message_id === p1._id);
    assert.equal(ex.reply_markup.inline_keyboard[0][2].text, "· 🖼 ·");
    assert.ok(ex.reply_markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith("lo:")).every((r) => r[0].text.startsWith("🖼")));
    assert.doesNotMatch(ex.text, /THÉÂTRE/);
    // /expos = la même liste, pré-filtrée
    c = await say(OWNER, "/expos");
    assert.equal(sends(c, OWNER)[0].reply_markup.inline_keyboard[0][2].text, "· 🖼 ·");
  });

  await step("item jamais rédigé : sa fiche existe quand même (titre + dates + lien) avec les boutons", async () => {
    const bare = play("bare00000001", "Sans Texte", ["2027-03-01 19:00"]);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, bare] });   // jamais /api/render
    const c = await click(LEA, "pv:berliner-ensemble:0", 6103);
    const card = sends(c, LEA).find((m) => /Sans Texte/.test(m.text));
    assert.match(card.text, /🎭 <b>Sans Texte<\/b>\n🗓 01\/03/);
    assert.equal(card.reply_markup.inline_keyboard[0].length, 3);
  });

  await step("lieu sauté par un scan (site en panne) : son programme reste dans /programme", async () => {
    const total = async () => (sends(await say(OWNER, "/programme"), OWNER)[0].text.match(/À l'affiche<\/b> \((\d+)\)/) || [])[1];
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear] });
    const before = await total();
    assert.ok(Number(before) > 0);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, lear] });   // rien de la Schaubühne
    assert.equal(await total(), before);
  });

  await step("horizon : expos ouvertes / sous 7 j, pièces jouées sous 14 j (ces dates seulement) ; annoncé en entrant", async () => {
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const soon = play("hzsoon000001", "Bientôt", [`${day(3)} 19:30`, `${day(40)} 19:30`]);
    const later = play("hzlater00001", "Plus tard", [`${day(40)} 19:30`]);
    const expoLater = { id: "hzexpo000001", venue_id: "kw", kind: "expo", title: "Sieverding 2027", url: "https://x/s",
      dates: [], start_date: day(60), end_date: day(200), starred: false };
    const H = { horizon_expo_days: 7, horizon_theatre_days: 14 };
    let p = await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, soon, later, expoLater], ...H });
    assert.ok(p.need.includes("hzsoon000001"));
    assert.ok(!p.need.includes("hzlater00001") && !p.need.includes("hzexpo000001"));   // gardés sans bruit
    const c = await click(OWNER, "pv:berliner-ensemble:0", 6200);
    const txt = sends(c, OWNER).map((m) => m.text).join("\n");
    assert.match(txt, /Bientôt/);
    assert.doesNotMatch(txt, /Plus tard/);
    const card = sends(c, OWNER).find((m) => /Bientôt/.test(m.text)).text;
    assert.ok(!card.includes(day(40).slice(8, 10) + "/" + day(40).slice(5, 7)), "date hors fenêtre affichée");
    const k = await click(OWNER, "pv:kw:0", 6201);
    assert.doesNotMatch(sends(k, OWNER).map((m) => m.text).join("\n"), /Sieverding/);
    // La pièce « plus tard » entre dans la fenêtre → annoncée (une fois).
    const later2 = play("hzlater00001", "Plus tard", [`${day(40)} 19:30`, `${day(5)} 20:00`]);
    p = await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, soon, later2, expoLater], ...H });
    assert.ok(p.need.includes("hzlater00001"));
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear], horizon_expo_days: 3650, horizon_theatre_days: 3650 });
  });

  // ------------------------------------------------------------ films
  await step("ciné : un message par film (⭐ ✅ 🔕), pas de renvoi sauf nouvelles séances", async () => {
    const d1 = `${soon(3)} 20:15`, d2 = `${soon(5)} 21:00`;
    const film = { id: "film00000001", venue_id: "cinema-intimes", title: "Barry Lyndon", url: "https://intimes/x",
      dates: [d1], text: "🎬 <b>Barry Lyndon</b>", line: "• Barry Lyndon",
      text_en: "🎬 <b>Barry Lyndon</b> [EN]", line_en: "• Barry Lyndon [EN]" };
    const run = async (f) => {
      const r = await api("/api/film-plan", { films: [f], targets: [{ chat_id: OWNER, ids: [f.id] }, { chat_id: LEA, ids: [f.id] }] });
      const sentList = r.messages.map(({ text, reply_markup, ...m }) => ({ ...m, message_id: nextId++ }));
      if (sentList.length) await api("/api/sent", { sent: sentList });
      return { ...r, sent: sentList };
    };
    let r = await run(film);
    const j = r.messages.find((m) => m.chat_id === OWNER), l = r.messages.find((m) => m.chat_id === LEA);
    assert.deepEqual(j.reply_markup.inline_keyboard[0].map((b) => b.text), ["⭐ Intéressé·e", "🙅 Pas pour moi", "✅ Déjà vu"]);
    assert.match(l.text, /\[EN\]/);
    assert.equal((await run(film)).messages.length, 0);                    // déjà reçu
    r = await run({ ...film, dates: [d1, d2] });                           // nouvelle séance
    assert.equal(r.messages.length, 2);
    assert.match(r.messages.find((m) => m.chat_id === OWNER).text, /Nouvelles séances<\/b> : \d\d\/\d\d 21:00/);
    // ⭐ de Justine : annonce au groupe avec la prochaine séance ; Léa « Moi aussi » → 🎟 Plan
    const jm = r.sent.find((m) => m.chat_id === OWNER).message_id;
    let c = await click(OWNER, "i:film00000001", jm);
    assert.match(sends(c, GROUP)[0].text, /^⭐ <b>Justine<\/b> est intéressé·e\n\n🎬 <b>Barry Lyndon<\/b>/);
    c = await click(LEA, "i:film00000001", 6300, GROUP, "group", "⭐ Justine …");
    assert.match(edits(c, GROUP)[0].text, /Plan !<\/b> Justine et Léa veulent y aller\n\n🎬/);
    assert.match(sends(await say(OWNER, "/interets"), OWNER)[0].text, /🎬 .*Barry Lyndon/);
    // /films : le film ⭐ reste dans la liste, sa ligne porte « ⭐ » ; déplié : boutons de l'état ⭐ + ↩︎ Liste
    const fl = sends(await say(OWNER, "/films"), OWNER)[0];
    assert.match(fl.text, /Barry Lyndon<\/a> — <i>Intimes<\/i>.* · ⭐/);
    const fb = fl.reply_markup.inline_keyboard.find((r) => r[0].callback_data === "lo:film00000001")[0];
    assert.equal(fb.text, "🎬 Barry Lyndon · ⭐");
    const fc = edits(await click(OWNER, fb.callback_data, fl._id), OWNER).find((x) => x.message_id === fl._id);
    assert.deepEqual(fc.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data[0])), [["b", "v"], ["i"], ["l"]]);
    // 🔕 : plus jamais, même avec de nouvelles séances
    await click(OWNER, "x:film00000001", jm);
    r = await run({ ...film, dates: [d1, d2, `${soon(6)} 19:00`] });
    assert.deepEqual(r.messages.map((m) => m.chat_id), []);   // Justine 🔕, Léa déjà ⭐ : rien
  });

  await step("décocher un théâtre, un lieu d'expo et un cinéma : plus rien de ces lieux, partout", async () => {
    const theatre = play("unselT00001", "Pièce décochée", [`${soon(4)} 19:30`]);
    const expoU = { id: "unselE00001", venue_id: "kw", kind: "expo", title: "Expo décochée", url: "https://kw/u",
      dates: [], start_date: "", end_date: soon(90), starred: false };
    // Léa décoche le BE, KW et l'Intimes : la case passe à ⬜️ et le reste
    for (const v of ["berliner-ensemble", "kw", "cinema-intimes"]) await click(LEA, `s:${v}`, 9500);
    const kb = sends(await say(LEA, "/suivre"), LEA)[0].reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(kb.some((t) => /^⬜️ .*Berliner Ensemble/.test(t)) && kb.some((t) => /^⬜️ .*KW/.test(t))
      && kb.some((t) => /^⬜️ .*Intimes/.test(t)), kb.join(" | "));
    // scan : aucune notif à Léa pour ces lieux
    const s = await scan([hedda, ente, lear, theatre, expoU]);
    assert.ok(!s.messages.some((m) => m.chat_id === LEA && ["unselT00001", "unselE00001"].includes(m.item_id)));
    // /programme : rien de BE ni de KW
    assert.doesNotMatch(sends(await say(LEA, "/programme"), LEA)[0].text, /Berliner Ensemble|KW Institute/);
    // récap : rien de ces lieux
    const d = (await scan([hedda, ente, lear, theatre, expoU], "digest")).messages
      .filter((m) => m.chat_id === LEA).map((m) => m.text).join("\n");
    assert.doesNotMatch(d, /décochée|King Lear/);
    // ciné : l'Intimes n'est plus dans ses cinémas
    const rc = (await api("/api/cinema-recipients", { venues: CINEMAS, force: true })).recipients.find((r) => r.chat_id === LEA);
    assert.ok(!rc || !JSON.parse(JSON.stringify(rc.venue_ids)).includes("cinema-intimes"));
  });

  await step("🎟 réserver : date proposée, autre date, annuler ; groupe « J'y vais aussi » ; « c'était comment ? »", async () => {
    const d1 = soon(5), d2 = soon(6);
    const bk = play("book00000001", "Mutter Courage", [`${d1} 19:30`, `${d2} 20:00`]);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, bk] });
    // la fiche a le bouton 🎟
    let c = await click(OWNER, "i:book00000001", 8101);
    // ⭐ : [🎟 Réserver] [✅ Déjà vu] / [↩︎ annuler ⭐]
    assert.deepEqual(edits(c, OWNER)[0].reply_markup.inline_keyboard, [
      [{ text: "🎟 Réserver", callback_data: "b:book00000001" }, { text: "✅ Déjà vu", callback_data: "v:book00000001" }],
      [{ text: "↩︎ annuler ⭐", callback_data: "i:book00000001" }]]);
    // 🎟 : LA fiche devient le sélecteur (même message) — en-tête gardé, dates, Autre date, ↩︎
    c = await click(OWNER, "b:book00000001", 8101);
    assert.equal(sends(c, OWNER).length, 0);
    const picker = edits(c, OWNER).find((x) => x.message_id === 8101);
    assert.match(picker.text, /^🎭 <a href="https:\/\/x\/book00000001">Mutter Courage<\/a> \(Berliner Ensemble\)\n\n🎟 Pour quelle date \?$/);
    const btns = picker.reply_markup.inline_keyboard.flat();
    assert.equal(btns[0].callback_data, `bd:book00000001:${d1.replace(/-/g, "")}1930`);
    assert.ok(btns.some((b) => b.callback_data === "bo:book00000001"));
    assert.deepEqual(picker.reply_markup.inline_keyboard.at(-1), [{ text: "↩︎ Retour", callback_data: "bb:book00000001" }]);
    // ↩︎ : la fiche revient telle quelle
    c = await click(OWNER, "bb:book00000001", 8101);
    assert.match(edits(c, OWNER).find((x) => x.message_id === 8101).text, /^🎭 <b>Mutter Courage<\/b>/);
    // réserver une date proposée : la fiche revient, avec « 🎟 Réservé · … 19:30 » ; annonce au groupe avec 🙋 + lien
    c = await click(OWNER, btns[0].callback_data, 8101);
    assert.equal(sends(c, OWNER).length, 0);
    // 🎟 avant la date : [📅 Changer la date] seulement
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === 8101).reply_markup.inline_keyboard,
      [[{ text: "📅 Changer la date", callback_data: "b:book00000001" }]]);
    assert.match(edits(c, OWNER).find((x) => x.message_id === 8101).text, /^🎭 <b>Mutter Courage<\/b>[\s\S]*🎟 <i>Réservé · .* 19:30<\/i>$/);
    const ann = sends(c, GROUP)[0];
    assert.match(ann.text, /^🎟 <b>Justine<\/b> a réservé <b>Mutter Courage<\/b> — .* 19:30 · Berliner Ensemble/);
    const row = ann.reply_markup.inline_keyboard[0];
    assert.equal(row[0].callback_data, `j:book00000001:${d1.replace(/-/g, "")}1930`);
    assert.equal(row[1].url, "https://x/book00000001");
    // /sorties : UNE liste dépliable — 🎟 Réservé en tête, ligne compacte, un bouton par item
    const li = sends(await say(OWNER, "/sorties"), OWNER)[0];
    assert.match(li.text, /^🗂 <b>Mes sorties<\/b>\n\n🎟 <b>Réservé<\/b>\n🎭 <a href="https:\/\/x\/book00000001">Mutter Courage<\/a> — <i>Berliner Ensemble<\/i> · 🎟 .* 19:30/);
    const lrows = li.reply_markup.inline_keyboard;
    assert.equal(lrows.find((r) => r[0].callback_data === "lo:book00000001")[0].text, "🎭 Mutter Courage · 🎟");
    assert.ok(lrows.every((r) => r.length === 1));                                  // un bouton pleine largeur par ligne
    // tap : LA liste devient la fiche (boutons d'état + ↩︎ Liste), aucun nouveau message
    c = await click(OWNER, "lo:book00000001", li._id);
    assert.equal(sends(c, OWNER).length, 0);
    const lc = edits(c, OWNER).find((x) => x.message_id === li._id);
    assert.match(lc.text, /^🎭 <b>Mutter Courage<\/b>[\s\S]*🎟 <i>Réservé · /);
    assert.deepEqual(lc.reply_markup.inline_keyboard,
      [[{ text: "📅 Changer la date", callback_data: "b:book00000001" }], [{ text: "↩︎ Liste", callback_data: "lb" }]]);
    // 🎟 → sélecteur dans ce même message ; ↩︎ Retour → la fiche (↩︎ Liste gardé) ; ↩︎ Liste → la liste
    c = await click(OWNER, "b:book00000001", li._id);
    assert.match(edits(c, OWNER).find((x) => x.message_id === li._id).text, /🎟 Pour quelle date/);
    c = await click(OWNER, "bb:book00000001", li._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === li._id).reply_markup.inline_keyboard.at(-1),
      [{ text: "↩︎ Liste", callback_data: "lb" }]);
    c = await click(OWNER, "lb", li._id);
    assert.match(edits(c, OWNER).find((x) => x.message_id === li._id).text, /^🗂 <b>Mes sorties<\/b>/);
    // Max (groupe) : « J'y vais aussi » → intéressé + lien en privé
    c = await click(MAX, row[0].callback_data, ann._id, GROUP, "group", ann.text);
    assert.match(sends(c, MAX)[0].text, /Mutter Courage[\s\S]*https:\/\/x\/book00000001/);
    // autre date : force_reply, date incomprise puis comprise → LA fiche est mise à jour, invitation + réponse supprimées
    c = await click(OWNER, "bo:book00000001", 8101);
    const ask = sends(c, OWNER).find((m) => m.reply_markup?.force_reply);
    assert.ok(ask);
    c = await say(OWNER, "bientôt", ask._id);
    assert.match(sends(c, OWNER)[0].text, /pas compris la date/);
    const [y, m, d] = d2.split("-");
    c = await say(OWNER, `${d}/${m} 20:00`, ask._id);
    assert.equal(sends(c, OWNER).length, 0);
    assert.match(edits(c, OWNER).find((x) => x.message_id === 8101).text, /🎟 <i>Réservé · .* 20:00<\/i>$/);
    assert.ok(c.some((x) => x.method === "deleteMessage" && x.message_id === ask._id));
    // le sélecteur propose maintenant « Annuler la réservation » ; annuler remet la fiche sans 🎟
    c = await click(OWNER, "b:book00000001", 8101);
    const p2 = edits(c, OWNER).find((x) => x.message_id === 8101);
    assert.ok(p2.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "bx:book00000001"));
    c = await click(OWNER, "bx:book00000001", 8101);
    const cancelled = edits(c, OWNER).find((x) => x.message_id === 8101);
    assert.match(cancelled.text, /^🎭 <b>Mutter Courage<\/b>/);
    assert.doesNotMatch(cancelled.text, /Réservé ·/);
    // lendemain : « Alors, c'était comment ? » une seule fois ; la note le marque vu
    const past = play("book00000002", "Woyzeck", [`${soon(-1)} 19:30`]);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, bk, past] });
    c = await click(OWNER, `bd:book00000002:${soon(-1).replace(/-/g, "")}1930`, 8102);
    // 🎟 dès le lendemain de la date : [★ Noter]
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === 8102).reply_markup.inline_keyboard,
      [[{ text: "★ Noter", callback_data: "v:book00000002" }]]);
    let r = await scan([hedda, ente, lear, bk, past]);
    const fu = r.messages.filter((x) => x.kind === "followup");
    assert.equal(fu.length, 1);
    assert.match(fu[0].text, /c'était comment, <b>Woyzeck<\/b>/);
    assert.equal(fu[0].reply_markup.inline_keyboard[0][4].callback_data, "r:book00000002:5");
    r = await scan([hedda, ente, lear, bk, past]);
    assert.equal(r.messages.filter((x) => x.kind === "followup").length, 0);
    // depuis /sorties : la ligne s'ouvre ; ★ Noter → 1–5★ sur place, ↩︎ Liste gardé
    const li2 = sends(await say(OWNER, "/sorties"), OWNER)[0];
    c = await click(OWNER, "lo:book00000002", li2._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === li2._id).reply_markup.inline_keyboard[0],
      [{ text: "★ Noter", callback_data: "v:book00000002" }]);
    c = await click(OWNER, "v:book00000002", li2._id);
    const k2 = edits(c, OWNER).find((x) => x.message_id === li2._id).reply_markup.inline_keyboard;
    assert.equal(k2[0].length, 5);
    assert.deepEqual(k2.at(-1), [{ text: "↩︎ Liste", callback_data: "lb" }]);
    // ↩︎ annuler ⭐ dans la fiche dépliée, puis ↩︎ Liste : la ligne a disparu ; pas « ignoré »
    const li3 = sends(await say(OWNER, "/sorties"), OWNER)[0];
    c = await click(OWNER, "lo:book00000001", li3._id);
    c = await click(OWNER, "i:book00000001", li3._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === li3._id).reply_markup.inline_keyboard.at(-1),
      [{ text: "↩︎ Liste", callback_data: "lb" }]);
    c = await click(OWNER, "lb", li3._id);
    assert.doesNotMatch(edits(c, OWNER).find((x) => x.message_id === li3._id).text, /Mutter Courage/);
    assert.equal(sends(c, OWNER).length, 0);
    assert.doesNotMatch(sends(await say(OWNER, "/ignores"), OWNER)[0].text, /Mutter Courage/);
    c = await click(OWNER, "r:book00000002:4", 8103);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === 8103).reply_markup.inline_keyboard,
      [[{ text: "✍️ Critique", callback_data: "w:book00000002" }]]);
    await say(OWNER, "/passer");
    // /sorties : section ✅ Vu avec ma note ; la ligne s'ouvre sur [✍️ Critique] + ↩︎ Liste
    const so = sends(await say(OWNER, "/sorties"), OWNER)[0];
    assert.match(so.text, /✅ <b>Vu<\/b>\n[\s\S]*Woyzeck<\/a> — <i>Berliner Ensemble<\/i> · ✅ ★★★★☆/);
    const rr = so.reply_markup.inline_keyboard.find((r) => r[0].callback_data === "lo:book00000002");
    assert.equal(rr[0].text, "🎭 Woyzeck · ✅");
    c = await click(OWNER, "lo:book00000002", so._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === so._id).reply_markup.inline_keyboard,
      [[{ text: "✍️ Critique", callback_data: "w:book00000002" }], [{ text: "↩︎ Liste", callback_data: "lb" }]]);
  });

  await step("un texte sans 📝 n'écrase pas un texte qui en a un (fr et en)", async () => {
    const it = play("syn000000001", "Nora", [`${soon(4)} 19:30`]);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, it] });
    await api("/api/render", { mode: "scan", items: [{ id: it.id, text: "🎭 Nora\n\n📝 Synopsis.", line: "• Nora",
      text_en: "🎭 Nora\n\n📝 Synopsis EN.", line_en: "• Nora" }] });
    await api("/api/render", { mode: "scan", items: [{ id: it.id, text: "🎭 Nora (nouvelle date)", line: "• Nora 2",
      text_en: "🎭 Nora (new date)", line_en: "• Nora 2" }] });
    let k = edits(await click(OWNER, "i:syn000000001", 9101), OWNER)[0].text;
    assert.match(k, /Nora \(nouvelle date\)\n\n📝 Synopsis\./);   // reste à jour + l'ancien 📝 remis
    await click(OWNER, "i:syn000000001", 9101);
    await api("/api/render", { mode: "scan", items: [{ id: it.id, text: "🎭 Nora v3\n\n📝 Synopsis v3.", line: "• Nora 3" }] });
    const c = await click(OWNER, "i:syn000000001", 9101);
    const txt = edits(c, OWNER)[0].text;
    assert.match(txt, /Nora v3[\s\S]*📝 Synopsis v3/);       // un nouveau 📝 remplace l'ancien
    await click(OWNER, "i:syn000000001", 9101);
    // format replié (<blockquote expandable>) : gardé lui aussi, balises intactes
    await api("/api/render", { mode: "scan", items: [{ id: it.id, text: "🎭 Nora v4\n\n<blockquote expandable>📝 Replié.</blockquote>\n\n🔗 x", line: "• Nora 4" }] });
    await api("/api/render", { mode: "scan", items: [{ id: it.id, text: "🎭 Nora v5\n\n🔗 x", line: "• Nora 5" }] });
    let t5 = edits(await click(OWNER, "i:syn000000001", 9101), OWNER)[0].text;
    assert.match(t5, /Nora v5\n\n<blockquote expandable>📝 Replié\.<\/blockquote>\n\n🔗 x/);
    await click(OWNER, "i:syn000000001", 9101);
    // fiche trop longue : coupée sans casser le HTML (le bloc replié est refermé)
    await api("/api/render", { mode: "scan", items: [{ id: it.id, line: "• Nora 6",
      text: "🎭 Nora v6\n\n<blockquote expandable>📝 " + "lorem ipsum ".repeat(400) + "</blockquote>" }] });
    t5 = edits(await click(OWNER, "i:syn000000001", 9101), OWNER)[0].text;
    assert.ok(t5.length <= 4096 && /…<\/blockquote>/.test(t5), t5.slice(-80));
    await click(OWNER, "i:syn000000001", 9101);
  });

  await step("/reglages : un message, 4 boutons -> lieux, langue, pas pour moi, groupe", async () => {
    const m = sends(await say(OWNER, "/reglages"), OWNER)[0];
    assert.match(m.text, /Réglages/);
    assert.deepEqual(m.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ["st:v", "st:l", "st:i", "st:g"]);
    assert.match(sends(await click(OWNER, "st:v", m._id), OWNER)[0].text, /Que veux-tu suivre/);
    assert.ok(sends(await click(OWNER, "st:l", m._id), OWNER)[0].reply_markup.inline_keyboard.flat().some((b) => b.callback_data.startsWith("l:")));
    assert.match(sends(await click(OWNER, "st:i", m._id), OWNER)[0].text, /Pas pour moi/);
    assert.match(sends(await click(OWNER, "st:g", m._id), OWNER)[0].text, /groupe de la bande est relié/);
  });

  await step("calendrier des ventes : /api/plan le range dans settings.sales (fusion par lieu)", async () => {
    const sale = { venue_id: "schaubuhne", day: soon(1), at: `${soon(1)}T11:00:00+01:00`, month: "2027-01", hour_known: true, source: "rule" };
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear], sales: { schaubuhne: sale } });
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear],
      sales: { "berliner-ensemble": { ...sale, venue_id: "berliner-ensemble" } } });
    const out = execSync(`npx wrangler d1 execute theatre-bot --local --json --command "SELECT value FROM settings WHERE key='sales'"`).toString();
    const v = JSON.parse(JSON.parse(out)[0].results[0].value);
    assert.deepEqual(Object.keys(v).sort(), ["berliner-ensemble", "schaubuhne"]);
  });

  await step("ventes : la veille 19:00 « Demain 10h … Tes ⭐ là-bas » (une fois), puis « C'est ouvert » à l'heure", async () => {
    const be = { venue_id: "berliner-ensemble", day: "2030-03-05", at: "2030-03-05T10:00:00+01:00", month: "2030-04", hour_known: true, source: "rule" };
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear], sales: { "berliner-ensemble": be } });
    take();
    let r = await api("/api/sales-tick", { now: "2030-03-04T17:55:00Z" });   // 18:55 Berlin : trop tôt
    assert.equal(r.sent, 0);
    r = await api("/api/sales-tick", { now: "2030-03-04T18:05:00Z" });       // 19:05 Berlin
    await settle();
    let c = take();
    const mine = sends(c, OWNER)[0];
    assert.match(mine.text, /^🎟 Demain 10h : ouverture des ventes Berliner Ensemble pour avril\.\nTes ⭐ là-bas :\n• <a href="https:\/\/x\/lear00000001">King Lear<\/a>/);
    const lea = sends(c, LEA)[0];
    if (lea) assert.match(lea.text, /^🎟 Tomorrow 10:00: Berliner Ensemble opens sales for April\.$/);   // pas de ⭐ là-bas : une ligne
    r = await api("/api/sales-tick", { now: "2030-03-04T19:20:00Z" });
    assert.equal(r.sent, 0);                                                  // une seule fois
    r = await api("/api/sales-tick", { now: "2030-03-05T09:05:00Z" });       // 10:05 Berlin
    c = take();
    assert.match(sends(c, OWNER)[0].text, /^🎟 C'est ouvert : ventes Berliner Ensemble pour avril\.\n• <a[^>]*>King Lear/);
    assert.equal(sends(c, LEA).length, 0);                                   // rien à réserver pour elle là-bas
    // heure non publiée : « dans la journée », jamais une heure inventée
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear],
      sales: { "berliner-ensemble": { ...be, day: "2030-05-02", at: null, hour_known: false } } });
    take();
    await api("/api/sales-tick", { now: "2030-05-01T17:30:00Z" });
    assert.match(sends(take(), OWNER)[0].text, /^🎟 Demain dans la journée : ouverture des ventes Berliner Ensemble/);
    // jour J à 09:00 : jamais « C'est ouvert » (peut-être pas encore vrai)
    await api("/api/sales-tick", { now: "2030-05-02T07:05:00Z" });           // 09:05 Berlin
    c = take();
    const today = sends(c, OWNER)[0].text;
    assert.match(today, /^🎟 Ventes Berliner Ensemble pour avril : ouverture aujourd'hui \(heure non publiée\)\n• <a[^>]*>King Lear/);
    assert.ok(!/ouvert :/.test(today));
  });

  await step("lot du matin : nouveautés en file, un message par jour à 9:00 (Berlin), bouton → fiche", async () => {
    sql("DELETE FROM settings WHERE key = 'immediate_cards'");
    const baal = play("baal00000001", "Baal", [`${soon(20)} 19:30`]);
    let s = await scan([baal]);
    assert.equal(s.messages.filter((m) => m.item_id === "baal00000001").length, 0);   // pas de push
    take();
    let r = await api("/api/daily-tick", { now: "2030-01-15T07:55:00Z" });             // 08:55 Berlin
    assert.equal(r.sent, 0);
    r = await api("/api/daily-tick", { now: "2030-01-15T08:05:00Z" });                 // 09:05 Berlin
    let c = take();
    const mine = sends(c, OWNER)[0];
    assert.match(mine.text, /^🆕 <b>Nouveau dans tes lieux<\/b> \(1\)\n.*Baal/);
    assert.deepEqual(mine.reply_markup.inline_keyboard, [[{ text: "🎭 Baal", callback_data: "lo:baal00000001" }]]);
    assert.match(sends(c).find((m) => m.chat_id !== OWNER).text, /^🆕 <b>New at your venues<\/b> \(1\)/);   // abonné·e en anglais
    assert.equal(sends(c, OWNER).length, 1);
    // une nouveauté plus tard dans la journée : attend le lendemain (un seul lot par jour)
    s = await scan([baal, play("ubu000000001", "Ubu Roi", [`${soon(21)} 20:00`])]);
    take();
    assert.equal((await api("/api/daily-tick", { now: "2030-01-15T10:00:00Z" })).sent, 0);
    await api("/api/daily-tick", { now: "2030-01-16T08:05:00Z" });
    c = take();
    assert.match(sends(c, OWNER)[0].text, /Ubu Roi/);
    assert.doesNotMatch(sends(c, OWNER)[0].text, /Baal/);                              // déjà dans le lot d'hier
    // rien en file : rien du tout
    assert.equal((await api("/api/daily-tick", { now: "2030-01-17T08:05:00Z" })).sent, 0);
    // le bouton déplie la fiche DANS le message du lot ; ⭐ l'édite sur place ; ↩︎ Liste : la ligne porte « ⭐ »
    c = await click(OWNER, "lo:baal00000001", mine._id);
    assert.equal(sends(c, OWNER).length, 0);
    const card = edits(c, OWNER).find((x) => x.message_id === mine._id);
    assert.match(card.text, /^🎭 <b>Baal<\/b>/);
    assert.deepEqual(card.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data)),
      [["i:baal00000001", "x:baal00000001", "v:baal00000001"], ["lb"]]);
    c = await click(OWNER, "i:baal00000001", mine._id);
    assert.deepEqual(edits(c, OWNER).find((x) => x.message_id === mine._id).reply_markup.inline_keyboard.at(-1),
      [{ text: "↩︎ Liste", callback_data: "lb" }]);
    c = await click(OWNER, "lb", mine._id);
    const back = edits(c, OWNER).find((x) => x.message_id === mine._id);
    assert.match(back.text, /Baal<\/a> — <i>Berliner Ensemble<\/i> · ⭐/);
    assert.equal(back.reply_markup.inline_keyboard[0][0].text, "🎭 Baal · ⭐");
    // jour d'ouverture des ventes au BE : nouvelles dates poussées tout de suite (⭐ d'abord, puis les
    // autres pièces du lieu) ; une pièce NOUVELLE va quand même au lot.
    const berlinToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
    const ubu = play("ubu000000001", "Ubu Roi", [`${soon(21)} 20:00`]);
    const sale = (day) => ({ "berliner-ensemble": { venue_id: "berliner-ensemble", day, at: null, month: "2030-02", hour_known: false, source: "rule" } });
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [baal, ubu], sales: sale(berlinToday) });
    s = await scan([{ ...baal, dates: [...baal.dates, `${soon(30)} 19:30`] }, { ...ubu, dates: [...ubu.dates, `${soon(31)} 20:00`] },
      play("woz000000001", "Woyzeck II", [`${soon(25)} 19:00`])]);
    const u = s.messages.find((m) => m.chat_id === OWNER && m.kind === "urgent");
    assert.match(u.text, /^🎟 <b>Nouvelles dates pour tes ⭐<\/b>\n🎟 <a[^>]*>Baal<\/a> <i>\(Berliner Ensemble\)<\/i> : \d\d\/\d\d 19:30\n\n🗓 <b>Aussi de nouvelles dates<\/b> \(vente ouverte\)\n🎟 <a[^>]*>Ubu Roi<\/a>/);
    assert.ok(!s.messages.some((m) => m.item_id === "woz000000001"));                // nouveauté : au lot
    await api("/api/daily-tick", { now: "2030-01-18T08:05:00Z" });
    assert.match(sends(take(), OWNER)[0].text, /^🆕 <b>Nouveau dans tes lieux<\/b> \(1\)\n.*Woyzeck II/);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [baal, ubu], sales: sale("2030-01-01") });
    // ---- récap du dimanche 9:00 : un en-tête (mes 🎟, expos qui ouvrent, nouveautés, ciné) puis les fiches films
    take();
    await click(OWNER, "bd:baal00000001:203001221930", 4343);                         // 🎟 mar. 22 janv.
    const expoSoon = { id: "expo00000009", venue_id: "kw", kind: "expo", title: "Hito Steyerl", url: "https://kw/h",
      dates: [], start_date: "2030-01-23", end_date: "2030-03-01", starred: false };
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [baal, ubu, expoSoon] });
    await api("/api/daily-tick", { now: "2030-01-19T08:05:00Z" });                    // lot du samedi (l'expo y passe ; dimanche, rappel « ouvre cette semaine »)
    const fl = { id: "film00000009", venue_id: "cinema-intimes", title: "Stalker", url: "https://intimes/s",
      dates: ["2030-01-24 20:00"], text: "🎬 <b>Stalker</b>", line: "• Stalker", text_en: "🎬 <b>Stalker</b> [EN]", line_en: "• Stalker [EN]" };
    const fp = await api("/api/film-plan", { films: [fl], queue: true, now: "2030-01-20T06:30:00Z",
      targets: [{ chat_id: OWNER, ids: [fl.id], header: "🎬 <b>Ciné de la semaine</b> — 20–26 janv." }] });
    assert.deepEqual(fp.messages, []);
    assert.equal(fp.queued, 1);
    take();
    assert.equal((await api("/api/daily-tick", { now: "2030-01-20T07:30:00Z" })).sent, 0);   // 08:30 Berlin
    await api("/api/daily-tick", { now: "2030-01-20T08:05:00Z" });                            // 09:05 Berlin
    c = take();
    const so = sends(c, OWNER);
    assert.equal(so.length, 1);                                                  // un seul message : les films y sont des items
    assert.equal(so[0].text, [
      "🎟 <b>Tes 🎟 cette semaine</b>\n🎭 <a href=\"https://x/baal00000001\">Baal</a> — mar. 22 janv. 19:30 <i>(Berliner Ensemble)</i>",
      "🖼 <b>Expos qui ouvrent cette semaine</b>\n• <a href=\"https://kw/h\">Hito Steyerl</a>\n   🗓 jusqu'au 01/03",
      "🎬 <b>Ciné de la semaine</b> — 20–26 janv.\n🎬 <a href=\"https://intimes/s\">Stalker</a> — <i>Intimes</i>",
    ].join("\n\n"));
    assert.deepEqual(so[0].reply_markup.inline_keyboard, [[{ text: "🎬 Stalker", callback_data: "lo:film00000009" }]]);
    assert.equal((await api("/api/daily-tick", { now: "2030-01-20T10:00:00Z" })).sent, 0);   // une fois
    // le film se déplie dans le récap (fiche de SES cinémas) ; ⭐ édite ce même message
    c = await click(OWNER, "lo:film00000009", so[0]._id);
    assert.match(edits(c, OWNER).find((x) => x.message_id === so[0]._id).text, /^🎬 <b>Stalker<\/b>/);
    c = await click(OWNER, "i:film00000009", so[0]._id);
    assert.ok(edits(c, OWNER).some((x) => x.message_id === so[0]._id));
    // dimanche suivant : l'expo qui ouvre cette semaine-là (hors lot) a sa section ; pas de ciné → n'attend que midi
    const expo2 = { ...expoSoon, id: "expo00000010", title: "Pipilotti Rist", start_date: "2030-01-30" };
    sql("INSERT OR REPLACE INTO deliveries (chat_id, item_id, dates, message_id) VALUES (111, 'expo00000010', '[]', NULL)");
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [baal, ubu, expoSoon, expo2] });
    take();
    assert.equal((await api("/api/daily-tick", { now: "2030-01-27T09:05:00Z" })).sent, 0);   // 10:05 : attend le ciné
    await api("/api/daily-tick", { now: "2030-01-27T11:05:00Z" });                            // 12:05 : sans films
    assert.match(sends(take(), OWNER)[0].text, /^🖼 <b>Expos qui ouvrent cette semaine<\/b>\n.*Pipilotti Rist/);
    // pagination : 10 nouveautés → 8 + 2, [◀] [1/2] [▶] ; ▶ change de page dans le même message
    const many = Array.from({ length: 10 }, (_, k) => play(`pg${String(k).padStart(10, "0")}`, `Stück ${k + 1}`, [`${soon(40 + k)} 19:00`]));
    await scan(many);
    take();
    await api("/api/daily-tick", { now: "2030-01-28T08:05:00Z" });
    const pg = sends(take(), OWNER)[0];
    const nav = pg.reply_markup.inline_keyboard.at(-1);
    assert.deepEqual(nav.map((b) => b.text), ["◀", "1/2", "▶"]);
    assert.equal(pg.reply_markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith("lo:")).length, 8);
    c = await click(OWNER, nav[2].callback_data, pg._id);
    const p2 = edits(c, OWNER).find((x) => x.message_id === pg._id);
    assert.equal(p2.reply_markup.inline_keyboard.filter((r) => r[0].callback_data.startsWith("lo:")).length, 2);
    assert.equal(p2.reply_markup.inline_keyboard.at(-1)[1].text, "2/2");
    // déplier depuis la page 2, puis ↩︎ Liste : retour à la page 2
    c = await click(OWNER, p2.reply_markup.inline_keyboard[0][0].callback_data, pg._id);
    c = await click(OWNER, "lb", pg._id);
    assert.equal(edits(c, OWNER).find((x) => x.message_id === pg._id).reply_markup.inline_keyboard.at(-1)[1].text, "2/2");
    sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('immediate_cards', '1')");
  });

  await step("sécurité : webhook sans secret et API sans token refusés", async () => {
    assert.equal((await fetch(`${W}/tg`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${W}/api/plan`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${W}/api/cinema-recipients`, { method: "POST", body: "{}" })).status, 401);
  });

  console.log(`\n✅ ${ok} étapes OK`);
} finally {
  dev.kill();
  tgServer.close();
  rmSync(".dev.vars", { force: true });
}
