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
const tgServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    calls.push({ method, ...JSON.parse(body || "{}"), _id: nextId });
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
    assert.deepEqual(kb, ["⭐ Intéressé·e", "✅ Vu", "🔕 Ignorer"]);
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

  await step("/interets liste ce qui tente la bande", async () => {
    const c = await say(LEA, "/interets");
    assert.match(sends(c, LEA)[0].text, /King Lear[\s\S]*⭐ Justine, <b>toi<\/b>|King Lear[\s\S]*⭐ <b>toi<\/b>, Justine/);
  });

  await step("Léa ✅ Vu → note 4★ → petit mot : partagé à la bande et au groupe", async () => {
    let c = await click(LEA, "v:lear00000001", msgs[LEA]);
    assert.equal(edits(c, LEA)[0].reply_markup.inline_keyboard[0].length, 5);   // 1★…5★
    c = await click(LEA, "r:lear00000001:4", msgs[LEA]);
    assert.match(sends(c, LEA)[0].text, /Un petit mot/);
    const review = sends(c, GROUP)[0];
    assert.match(review.text, /^✅ <b>Léa<\/b> a vu\n★★★★☆ 4\/5\n\n🎭 <b>King Lear<\/b>/);
    assert.deepEqual(review.reply_markup.inline_keyboard[0].map((b) => b.text), ["🙋 Moi aussi", "✅ Je l'ai vu aussi"]);
    c = await say(LEA, "Bouleversant, Lars Eidinger incroyable");
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
    const p1 = sends(c, LEA).find((m) => m.reply_markup?.force_reply);
    assert.equal(p1.reply_markup.input_field_placeholder, "Ton avis sur Hedda Gabler…");
    c = await click(LEA, "v:rvB000000001", 7002);
    c = await click(LEA, "r:rvB000000001:3", 7002);
    const p2 = sends(c, LEA).find((m) => m.reply_markup?.force_reply);
    assert.match(p2.text, /Die Möwe/);
    // réponse à la 1re invitation d'abord (ordre inverse) → Hedda
    c = await say(LEA, "Gabler : magistral", p1._id);
    assert.match(sends(c, LEA)[0].text, /Avis enregistré pour <b>Hedda Gabler<\/b>/);
    // puis texte libre sans « répondre » → l'invitation ouverte restante (Wildente)
    c = await say(LEA, "Möwe : un peu long");
    assert.match(sends(c, LEA)[0].text, /Avis enregistré pour <b>Die Möwe<\/b>/);
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
    // la carte d'un item noté a le bouton ✍️
    const kb = edits(await click(LEA, "r:rvA000000001:5", 7001), LEA)[0].reply_markup.inline_keyboard;
    assert.ok(kb.flat().some((b) => b.callback_data === "w:rvA000000001"));
    await say(LEA, "/passer");
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear] });
  });

  await step("Justine 🔕 Ignorer Hedda", async () => {
    const c = await click(OWNER, "x:hedda0000001", 4242);
    assert.match(edits(c, OWNER)[0].text, /Ignoré/);
  });

  await step("nouvelles dates : seulement à qui n'a ni vu, ni ignoré, ni déjà ⭐", async () => {
    const s = await scan([
      { ...hedda, dates: [...hedda.dates, "2026-12-10 20:00"] },
      ente,
      { ...lear, dates: [...lear.dates, "2026-12-15 19:30"] },
    ]);
    // Hedda : Justine ignore → Léa seule. Lear : Léa a vu, Justine l'a déjà ⭐
    // (dans /interets) → personne : on ne repropose pas ce qui est déjà noté.
    const got = s.messages.map((m) => `${m.chat_id}:${m.item_id}`).sort();
    assert.deepEqual(got, [`${LEA}:hedda0000001`]);
    assert.match(s.messages[0].text, /🆕 <b>Nouvelles dates<\/b> : 10\/12/);
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
    assert.match(sends(await say(LEA, "/programme"), LEA)[0].text, /À l'affiche<\/b> — choisis/);
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
    assert.match(sends(await say(MAX, "/aide"), MAX)[0].text, /ciné de la semaine/);
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
    assert.ok(menu && menu.commands.some((m) => m.command === "language"), "menu par chat en anglais");
    assert.match(edits(c, LEA)[0].text, /English/);
    assert.match(sends(await say(LEA, "/aide"), LEA)[0].text, /How it works[\s\S]*\/language/);
    assert.match(sends(await say(LEA, "/suivre"), LEA)[0].text, /What do you want to follow/);
    assert.match(sends(await say(OWNER, "/aide"), OWNER)[0].text, /Comment ça marche/);   // Justine reste en français
  });

  await step("langue : notif rendue en anglais pour Léa, en français pour Justine", async () => {
    const peer = play("peer00000001", "Peer Gynt", ["2027-02-01 19:00"]);
    const s = await scan([hedda, ente, lear, peer]);
    assert.ok(s.langs.includes("en"));
    const lea = s.messages.find((m) => m.chat_id === LEA), jus = s.messages.find((m) => m.chat_id === OWNER);
    assert.match(lea.text, /Peer Gynt<\/b> \[EN\]/);
    assert.deepEqual(lea.reply_markup.inline_keyboard[0].map((b) => b.text), ["⭐ Interested", "✅ Seen", "🔕 Ignore"]);
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
    assert.match(sends(await say(LEA, "/programme"), LEA)[0].text, /What's on/);
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

  await step("/programme : menu court (catégories + lieux), puis fiches complètes 5 par 5 avec ⭐ ✅ 🔕", async () => {
    let c = await say(OWNER, "/programme");
    const menu = sends(c, OWNER)[0];
    assert.equal(sends(c, OWNER).length, 1);                              // pas de déversoir
    const btns = menu.reply_markup.inline_keyboard.flat();
    assert.ok(btns.some((b) => b.callback_data === "pk:theatre:0" && /^🎭 Théâtre \(\d+\)$/.test(b.text)));
    assert.ok(btns.some((b) => b.callback_data === "pv:berliner-ensemble:0"));
    c = await click(OWNER, "pv:berliner-ensemble:0", 6100);
    const cards = sends(c, OWNER).filter((m) => !m.text.startsWith("Il y en a"));
    assert.ok(cards.length >= 1 && cards.length <= 5);
    for (const m of cards) {
      assert.deepEqual(m.reply_markup.inline_keyboard[0].map((b) => b.callback_data[0]), ["i", "v", "x"]);
    }
    // pagination : 7 pièces au Berliner Ensemble → 5 + « Plus ▸ » → 2
    const extra = [1, 2, 3, 4, 5].map((n) => play(`page0000000${n}`, `Pièce ${n}`, [`2027-0${n}-10 19:00`]));
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear, ...extra] });
    c = await click(OWNER, "pv:berliner-ensemble:0", 6101);
    const more = sends(c, OWNER).at(-1);
    assert.equal(sends(c, OWNER).length, 6);
    assert.equal(more.reply_markup.inline_keyboard[0][0].callback_data, "pv:berliner-ensemble:5");
    c = await click(OWNER, "pv:berliner-ensemble:5", 6102);
    assert.ok(sends(c, OWNER).length >= 1 && !sends(c, OWNER).some((m) => m.text.startsWith("Il y en a")));
    c = await say(OWNER, "/expos");
    assert.ok(sends(c, OWNER)[0].reply_markup.inline_keyboard.flat().every((b) => b.callback_data.startsWith("pv:kw")));
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
    const menu = async () => sends(await say(OWNER, "/programme"), OWNER)[0].reply_markup.inline_keyboard.flat().map((b) => b.text).join("|");
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, ente, lear] });
    const schau = (m) => (m.match(/Schaubühne \(\d+\)/) || [""])[0];
    const before = schau(await menu());
    assert.ok(before);
    await api("/api/plan", { mode: "scan", venues: VENUES, items: [hedda, lear] });   // rien de la Schaubühne
    assert.equal(schau(await menu()), before);   // (comparaison ciblée : horodatage à la seconde)
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
    assert.deepEqual(j.reply_markup.inline_keyboard[0].map((b) => b.text), ["⭐ Intéressé·e", "✅ Vu", "🔕 Ignorer"]);
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
    // ⭐ : plus reproposé dans « Films de la semaine », il vit dans « Nos envies »
    const menu = sends(await say(OWNER, "/programme"), OWNER)[0].reply_markup.inline_keyboard.flat();
    assert.ok(!menu.some((b) => b.callback_data === "pk:film:0"));
    assert.ok(menu.some((b) => b.callback_data === "pk:star:0"));
    const cards = sends(await click(OWNER, "pk:star:0", 6400), OWNER).filter((m) => /Barry Lyndon/.test(m.text));
    assert.match(cards[0].text, /Barry Lyndon/);
    assert.equal(cards[0].reply_markup.inline_keyboard[0].length, 3);
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
    // /programme : ni BE ni KW au menu
    const menu = sends(await say(LEA, "/programme"), LEA)[0].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(!menu.includes("pv:berliner-ensemble:0") && !menu.includes("pv:kw:0"), menu.join(" "));
    // récap : rien de ces lieux
    const d = (await scan([hedda, ente, lear, theatre, expoU], "digest")).messages
      .filter((m) => m.chat_id === LEA).map((m) => m.text).join("\n");
    assert.doesNotMatch(d, /décochée|King Lear/);
    // ciné : l'Intimes n'est plus dans ses cinémas
    const rc = (await api("/api/cinema-recipients", { venues: CINEMAS, force: true })).recipients.find((r) => r.chat_id === LEA);
    assert.ok(!rc || !JSON.parse(JSON.stringify(rc.venue_ids)).includes("cinema-intimes"));
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
