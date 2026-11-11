// Face ID / empreinte (passkeys WebAuthn) pour l'app web.
// Le visage ne quitte jamais le téléphone : on ne garde qu'une CLÉ PUBLIQUE par appareil,
// qui sert à vérifier la signature d'un défi à usage unique. Le code par email reste le secours.
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Env } from "./lib";

const CHALLENGE_MIN = 5;
const b64u = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const randomId = () => b64u.enc(crypto.getRandomValues(new Uint8Array(16)));

/** Domaine de la page (rpID) et origine attendue : berlinencore.app en prod, localhost en test. */
export function rpOf(req: Request, env?: Env): { rpID: string; origin: string } | null {
  // PASSKEY_ORIGIN : tests locaux seulement (wrangler dev réécrit l'en-tête Origin).
  const origin = env?.PASSKEY_ORIGIN || req.headers.get("origin") || "";
  try {
    const u = new URL(origin);
    const ok = u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return ok ? { rpID: u.hostname, origin: u.origin } : null;
  } catch { return null; }
}

async function saveChallenge(env: Env, challenge: string, chat: number | null): Promise<string> {
  const id = randomId();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_challenges WHERE created_at < datetime('now', ?)").bind(`-${CHALLENGE_MIN} minutes`),
    env.DB.prepare("INSERT INTO passkey_challenges (id, challenge, chat_id) VALUES (?, ?, ?)").bind(id, challenge, chat),
  ]);
  return id;
}
async function takeChallenge(env: Env, id: string): Promise<{ challenge: string; chat_id: number | null } | null> {
  const row = await env.DB.prepare("SELECT challenge, chat_id FROM passkey_challenges WHERE id = ? AND created_at > datetime('now', ?)")
    .bind(id, `-${CHALLENGE_MIN} minutes`).first<{ challenge: string; chat_id: number | null }>();
  await env.DB.prepare("DELETE FROM passkey_challenges WHERE id = ?").bind(id).run();   // usage unique
  return row;
}

/** Connecté·e : options pour créer une passkey sur cet appareil. */
export async function registerOptions(env: Env, req: Request, chat: number) {
  const rp = rpOf(req, env); if (!rp) return { error: "bad_origin" };
  const u = await env.DB.prepare("SELECT first_name, handle, email FROM users WHERE chat_id = ?").bind(chat)
    .first<{ first_name: string; handle: string | null; email: string | null }>();
  const { results } = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE chat_id = ?").bind(chat).all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "Berlin Encore!", rpID: rp.rpID,
    userID: new Uint8Array(new TextEncoder().encode(String(chat))),
    userName: u?.email || (u?.handle ? `@${u.handle}` : u?.first_name || "Berlin Encore!"),
    userDisplayName: u?.first_name || "",
    attestationType: "none",
    excludeCredentials: results.map((r) => ({ id: r.id, transports: r.transports ? JSON.parse(r.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { id: await saveChallenge(env, options.challenge, chat), options };
}

export async function registerVerify(env: Env, req: Request, chat: number, body: any) {
  const rp = rpOf(req, env); if (!rp) return { error: "bad_origin" };
  const ch = await takeChallenge(env, String(body.id ?? ""));
  if (!ch || ch.chat_id !== chat) return { error: "expired" };
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch (e) { console.log("passkey register", String(e)); return { error: "bad_passkey" }; }
  if (!v.verified || !v.registrationInfo) return { error: "bad_passkey" };
  const c = v.registrationInfo.credential;
  const device = String(body.device ?? "").replace(/[^\w .,()-]/g, "").slice(0, 40) || null;
  await env.DB.prepare("INSERT OR REPLACE INTO passkeys (id, chat_id, public_key, counter, transports, device) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(c.id, chat, b64u.enc(c.publicKey), c.counter, c.transports ? JSON.stringify(c.transports) : null, device).run();
  return { ok: true };
}

/** Pas connecté·e : défi à signer (passkey « découvrable » : pas besoin de l'email). */
export async function loginOptions(env: Env, req: Request) {
  const rp = rpOf(req, env); if (!rp) return { error: "bad_origin" };
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
  return { id: await saveChallenge(env, options.challenge, null), options };
}

/** Signature vérifiée → chat_id de la personne (la session est créée par l'appelant). */
export async function loginVerify(env: Env, req: Request, body: any): Promise<{ chat: number } | { error: string }> {
  const rp = rpOf(req, env); if (!rp) return { error: "bad_origin" };
  const ch = await takeChallenge(env, String(body.id ?? ""));
  if (!ch) return { error: "expired" };
  const credId = String(body.response?.id ?? "");
  const pk = await env.DB.prepare(
    "SELECT p.id, p.chat_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.chat_id = p.chat_id AND u.active = 1 WHERE p.id = ?",
  ).bind(credId).first<{ id: string; chat_id: number; public_key: string; counter: number; transports: string | null }>();
  if (!pk) return { error: "unknown_passkey" };
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: pk.id, publicKey: b64u.dec(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
    });
  } catch (e) { console.log("passkey login", String(e)); return { error: "bad_passkey" }; }
  if (!v.verified) return { error: "bad_passkey" };
  await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?").bind(v.authenticationInfo.newCounter, pk.id).run();
  return { chat: pk.chat_id };
}

export async function listPasskeys(env: Env, chat: number) {
  const { results } = await env.DB.prepare("SELECT id, device, created_at, last_used_at FROM passkeys WHERE chat_id = ? ORDER BY created_at")
    .bind(chat).all<{ id: string; device: string | null; created_at: string; last_used_at: string | null }>();
  return results;
}
export async function removePasskey(env: Env, chat: number, id: string) {
  await env.DB.prepare("DELETE FROM passkeys WHERE chat_id = ? AND id = ?").bind(chat, id).run();
}
