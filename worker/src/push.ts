// Web Push (notifications sur le téléphone, appli web ajoutée à l'écran d'accueil).
// Standard : VAPID (RFC 8292) pour prouver que c'est nous, chiffrement aes128gcm (RFC 8291) :
// Apple / Google transportent le message sans pouvoir le lire. On ne garde par appareil que
// l'adresse d'envoi fournie par le navigateur et ses clés publiques.
import type { Env } from "./lib";

const enc = new TextEncoder();
const b64u = {
  enc: (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}

/** Jeton VAPID (JWT ES256) pour l'origine du service de push. */
async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY || "{}");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://berlinencore.app" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Chiffrement aes128gcm (RFC 8291) d'un message pour un abonnement (p256dh + auth). */
export async function encrypt(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64u.dec(p256dh), authSecret = b64u.dec(auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, eph.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // 4096
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export type PushMsg = { title: string; body: string; url?: string; tag?: string };

/** Envoie à tous les appareils de la personne ; supprime les abonnements expirés (404/410). */
export async function pushTo(env: Env, chat: number, msg: PushMsg): Promise<number> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return 0;
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE chat_id = ?").bind(chat)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  let ok = 0;
  for (const s of results) {
    try {
      const body = await encrypt(enc.encode(JSON.stringify(msg)), s.p256dh, s.auth);
      const r = await fetch(s.endpoint, { method: "POST", body, headers: {
        authorization: await vapidHeader(env, s.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
        ttl: "86400", urgency: "normal", ...(msg.tag ? { topic: msg.tag.replace(/[^\w-]/g, "").slice(0, 32) } : {}),
      } });
      if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
      else if (r.ok) { ok++; await env.DB.prepare("UPDATE push_subs SET last_ok_at = datetime('now') WHERE endpoint = ?").bind(s.endpoint).run(); }
      else console.log("push failed", r.status, (await r.text().catch(() => "")).slice(0, 200));
    } catch (e) { console.log("push error", String(e)); }
  }
  return ok;
}

export async function subscribe(env: Env, chat: number, sub: any): Promise<boolean> {
  const endpoint = String(sub?.endpoint ?? ""), p256dh = String(sub?.keys?.p256dh ?? ""), auth = String(sub?.keys?.auth ?? "");
  if (!/^https:\/\/[\w.-]+\//.test(endpoint) || endpoint.length > 1000 || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,30}$/.test(auth)) return false;
  await env.DB.prepare("INSERT OR REPLACE INTO push_subs (endpoint, chat_id, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)")
    .bind(endpoint, chat, p256dh, auth, String(sub?.device ?? "").replace(/[^\w ]/g, "").slice(0, 30) || null).run();
  return true;
}
export async function unsubscribe(env: Env, chat: number, endpoint: string) {
  await env.DB.prepare("DELETE FROM push_subs WHERE chat_id = ? AND endpoint = ?").bind(chat, endpoint).run();
}
export async function pushCount(env: Env, chat: number): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) n FROM push_subs WHERE chat_id = ?").bind(chat).first<{ n: number }>())?.n ?? 0;
}

/** Une notification de la boîte « Pour toi » devient aussi une notif sur le téléphone. */
export async function notifyPush(env: Env, chat: number, kind: string, from: number | null, item: string | null, note: string | null, at: string | null) {
  if (!env.VAPID_PRIVATE_KEY) return;
  const has = await env.DB.prepare("SELECT 1 FROM push_subs WHERE chat_id = ? LIMIT 1").bind(chat).first();
  if (!has) return;
  const me = await env.DB.prepare("SELECT lang FROM users WHERE chat_id = ?").bind(chat).first<{ lang: string | null }>();
  const who = from ? (await env.DB.prepare("SELECT first_name FROM users WHERE chat_id = ?").bind(from).first<{ first_name: string }>())?.first_name ?? "?" : "?";
  const title = item ? (await env.DB.prepare("SELECT title FROM items WHERE id = ?").bind(item).first<{ title: string }>())?.title ?? "" : "";
  const en = me?.lang === "en";
  const when = at ? ` · ${at.slice(8, 10)}/${at.slice(5, 7)} ${at.slice(11, 16)}` : "";
  const M: Record<string, PushMsg> = {
    share: { title: en ? `💌 ${who} sent you ${title}` : `💌 ${who} t'envoie ${title}`, body: note ? `« ${note} »` : (en ? "Have a look?" : "Tu regardes ?"), url: "/app#mine/all" },
    booked: { title: en ? `🎟 ${who} booked ${title} for you` : `🎟 ${who} a réservé ${title} pour toi`, body: (en ? "See it in My outings" : "C'est dans Mes sorties") + when, url: "/app#mine/all" },
    friend_request: { title: en ? `👋 ${who} wants to add you` : `👋 ${who} veut t'ajouter`, body: en ? "Accept in Friends" : "À accepter dans Amis", url: "/app#set/friends" },
    friend_ok: { title: en ? `🤝 ${who} accepted your request` : `🤝 ${who} a accepté ta demande`, body: en ? "You now see each other's picks" : "Vous voyez maintenant vos envies", url: "/app#set/friends" },
  };
  const msg = M[kind]; if (!msg) return;
  await pushTo(env, chat, { ...msg, tag: `${kind}-${item ?? from ?? ""}` });
}
