import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  /** Public origin of the deployment, e.g. https://rupee.example.workers.dev */
  PUBLIC_URL: string;
  /** Shared household password (Worker secret). */
  APP_PASSWORD: string;
  /** Random 32+ char string used to sign session cookies (Worker secret). */
  SESSION_SECRET: string;
  /** Injected by OAuthProvider for the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}
