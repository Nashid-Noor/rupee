// Worker entry: OAuthProvider guards /mcp and serves the OAuth protocol endpoints;
// everything else (PWA, REST API, authorize page) goes to the Hono app.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import app from './app';
import { verifyApiToken } from './auth';
import type { Env } from './env';
import { handleMcp } from './mcp';

let cached: { url: string; provider: OAuthProvider<Env> } | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  const base = env.PUBLIC_URL.replace(/\/+$/, '');
  if (cached?.url === base) return cached.provider;
  const resource = `${base}/mcp`;

  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { fetch: (request, env) => handleMcp(request, env as Env) },
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['expenses'],
    requiredScopes: ['expenses'],
    accessTokenTTL: 60 * 60, // 1 hour; clients refresh automatically
    refreshTokenTTL: 90 * 24 * 60 * 60, // stay connected for 90 days
    resourceMetadata: {
      resource,
      authorization_servers: [base],
      resource_name: 'Rupee household expenses',
    },
    // Personal access tokens (created in the PWA settings page) for clients
    // that take a URL plus an "Authorization: Bearer <token>" header.
    resolveExternalToken: async ({ token, env }) => {
      const id = await verifyApiToken(env.DB, token);
      return id ? { props: { userId: 'household', tokenId: id }, audience: resource } : null;
    },
  });
  cached = { url: base, provider };
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
