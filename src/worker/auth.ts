// Shared-password login, signed session cookies, and personal access tokens.
import type { Env } from './env';

const enc = new TextEncoder();
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'rupee_session';
export const MIN_PASSWORD_LENGTH = 10;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time password check (both sides hashed so lengths always match). */
export async function checkPassword(env: Env, candidate: string): Promise<boolean> {
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`APP_PASSWORD secret must be set and at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(candidate)),
    crypto.subtle.digest('SHA-256', enc.encode(env.APP_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET secret must be set and at least 32 characters');
  }
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Session token = base64url(payload) "." base64url(HMAC(payload)). */
export async function createSession(env: Env): Promise<{ token: string; maxAge: number }> {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const payload = b64url(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + maxAge })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload));
  return { token: `${payload}.${b64url(sig)}`, maxAge };
}

export async function verifySession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(sig) as Uint8Array<ArrayBuffer>, enc.encode(payload));
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

// ---- Personal access tokens -------------------------------------------------

export interface ApiTokenInfo {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export async function createApiToken(db: D1Database, name: string): Promise<{ token: string; info: ApiTokenInfo }> {
  const token = `rupee_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const info = await db
    .prepare('INSERT INTO api_tokens (id, name, token_hash) VALUES (?, ?, ?) RETURNING id, name, created_at, last_used_at')
    .bind(crypto.randomUUID(), name, await sha256Hex(token))
    .first<ApiTokenInfo>();
  return { token, info: info! };
}

export async function listApiTokens(db: D1Database): Promise<ApiTokenInfo[]> {
  const { results } = await db
    .prepare('SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC')
    .all<ApiTokenInfo>();
  return results;
}

export async function deleteApiToken(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
  return res.meta.changes > 0;
}

/** Returns the token id if valid, and records when it was last used. */
export async function verifyApiToken(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith('rupee_')) return null;
  const row = await db
    .prepare(
      "UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ? RETURNING id",
    )
    .bind(await sha256Hex(token))
    .first<{ id: string }>();
  return row?.id ?? null;
}
