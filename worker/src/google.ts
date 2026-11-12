// Connexion avec Google (Google Identity Services) : le navigateur reçoit un « ID token » (JWT signé RS256 par Google),
// le Worker vérifie la signature avec les clés publiques de Google, puis l'émetteur, le destinataire (notre client ID),
// l'expiration et que l'email est vérifié. Rien n'est stocké chez Google ni chez nous à part l'email du compte.
import type { Env } from "./lib";

const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
let keys: { at: number; jwks: any[] } | null = null;

const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function jwks(env: Env, force = false): Promise<any[]> {
  if (!force && keys && Date.now() - keys.at < 3600_000) return keys.jwks;
  const r = await fetch(env.GOOGLE_CERTS || CERTS);
  if (!r.ok) throw new Error("google certs " + r.status);
  keys = { at: Date.now(), jwks: ((await r.json()) as any).keys || [] };
  return keys.jwks;
}

export type GoogleUser = { email: string; name: string; sub: string };

/** null si le jeton n'est pas valable. */
export async function verifyGoogle(env: Env, token: unknown): Promise<GoogleUser | null> {
  if (!env.GOOGLE_CLIENT_ID || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let head: any, body: any;
  try { head = JSON.parse(new TextDecoder().decode(dec(parts[0]))); body = JSON.parse(new TextDecoder().decode(dec(parts[1]))); } catch { return null; }
  if (head.alg !== "RS256" || !head.kid) return null;
  let jwk = (await jwks(env)).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await jwks(env, true)).find((k) => k.kid === head.kid);   // Google a tourné ses clés
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(body.iss)) return null;
  if (body.aud !== env.GOOGLE_CLIENT_ID || !(body.exp > now) || !(body.iat < now + 300)) return null;
  if (body.email_verified !== true && body.email_verified !== "true") return null;
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return null;
  const name = String(body.given_name || body.name || email.split("@")[0]).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  return { email, name, sub: String(body.sub) };
}
