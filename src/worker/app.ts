// Default handler: REST API for the PWA, the OAuth authorize page, and static assets.
import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { expenseInput, expensePatch, listQuery, rangeQuery } from '../shared/schema';
import {
  SESSION_COOKIE,
  checkPassword,
  createApiToken,
  createSession,
  deleteApiToken,
  listApiTokens,
  verifySession,
} from './auth';
import type { Env } from './env';
import { addExpense, deleteExpense, getSummary, listExpenses, updateExpense } from './expenses';

const app = new Hono<{ Bindings: Env }>();

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:';

async function startSession(c: Context<{ Bindings: Env }>) {
  const { token, maxAge } = await createSession(c.env);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

function zodError(c: Context, err: z.ZodError) {
  return c.json({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') }, 400);
}

// ---- Session ---------------------------------------------------------------

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (!(await checkPassword(c.env, password))) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return c.json({ error: 'Wrong password' }, 401);
  }
  await startSession(c);
  return c.json({ ok: true });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Everything else under /api requires a session.
app.use('/api/*', async (c, next) => {
  if (!(await verifySession(c.env, getCookie(c, SESSION_COOKIE)))) return c.json({ error: 'Not signed in' }, 401);
  // CSRF: mutating requests must be JSON (cross-site forms can't send that without CORS).
  if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && !c.req.header('content-type')?.includes('application/json')) {
    return c.json({ error: 'Expected application/json' }, 415);
  }
  await next();
});

app.get('/api/session', (c) => c.json({ ok: true, mcpUrl: `${c.env.PUBLIC_URL}/mcp` }));

// ---- Expenses --------------------------------------------------------------

app.get('/api/expenses', async (c) => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) return zodError(c, q.error);
  return c.json(await listExpenses(c.env.DB, q.data));
});

app.post('/api/expenses', async (c) => {
  const input = expenseInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return zodError(c, input.error);
  return c.json(await addExpense(c.env.DB, input.data, 'web'), 201);
});

app.patch('/api/expenses/:id', async (c) => {
  const patch = expensePatch.safeParse(await c.req.json().catch(() => null));
  if (!patch.success) return zodError(c, patch.error);
  const e = await updateExpense(c.env.DB, c.req.param('id'), patch.data);
  return e ? c.json(e) : c.json({ error: 'Not found' }, 404);
});

app.delete('/api/expenses/:id', async (c) => {
  const ok = await deleteExpense(c.env.DB, c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
});

app.get('/api/summary', async (c) => {
  const q = rangeQuery.safeParse(c.req.query());
  if (!q.success) return zodError(c, q.error);
  return c.json(await getSummary(c.env.DB, q.data));
});

// ---- Personal access tokens ------------------------------------------------

app.get('/api/tokens', async (c) => c.json(await listApiTokens(c.env.DB)));

app.post('/api/tokens', async (c) => {
  const body = z
    .object({ name: z.string().trim().min(1).max(60) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return zodError(c, body.error);
  return c.json(await createApiToken(c.env.DB, body.data.name), 201);
});

app.delete('/api/tokens/:id', async (c) => {
  const ok = await deleteApiToken(c.env.DB, c.req.param('id'));
  return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ---- OAuth authorize page (for MCP clients) ---------------------------------

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function authorizePage(d: ConsentDescription, handle: string, query: string, needPassword: boolean, error?: string) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${esc(d.clientName)} to Rupee</title>
<style>
  :root{--bg:#f6f5f1;--card:#fff;--fg:#1c1b19;--muted:#6b6862;--accent:#0f766e;--line:#e4e1da;--err:#b42318}
  @media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1d1b;--fg:#f0eee9;--muted:#a19d94;--accent:#2dd4bf;--line:#33312d;--err:#f97066}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;max-width:420px;width:100%}
  h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--fg)}
  .warn{background:color-mix(in srgb,var(--err) 12%,transparent);color:var(--fg);padding:10px 12px;border-radius:10px}
  .err{color:var(--err);font-weight:600}
  input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit;margin:4px 0 16px}
  .row{display:flex;gap:10px}button{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);font:inherit;font-weight:600;cursor:pointer;background:transparent;color:var(--fg)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  @media (prefers-color-scheme:dark){button.primary{color:#04201d}}
</style></head><body><main class="card">
<h1>Allow <strong>${esc(d.clientName)}</strong> to use Rupee?</h1>
<p>${origin} It will be able to add, view, edit and delete your household expenses.</p>
<p>Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <input type="hidden" name="q" value="${esc(query)}">
  ${needPassword ? '<label for="pw">Household password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>' : ''}
  <div class="row"><button name="decision" value="deny" formnovalidate>Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form></main></body></html>`;
}

function plainError(message: string, status = 400) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function withAuthErrors(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return plainError(`${error.description} Please try connecting again.`);
    if (error instanceof CimdFetchError) return plainError('This app could not be verified. Please try again.');
    throw error;
  }
}

app.get('/authorize', (c) =>
  withAuthErrors(async () => {
    const url = new URL(c.req.url);
    const error = url.searchParams.get('rupee_error') ?? undefined;
    url.searchParams.delete('rupee_error');
    const oauth = c.env.OAUTH_PROVIDER;
    const request = await oauth.parseAuthRequest(new Request(url, c.req.raw));
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const signedIn = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(authorizePage(details, consent.handle, url.search.slice(1), !signedIn, error), {
      headers: consent.headers,
    });
  }),
);

app.post('/authorize', (c) =>
  withAuthErrors(async () => {
    const oauth = c.env.OAUTH_PROVIDER;
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '');

    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const signedIn = await verifySession(c.env, getCookie(c, SESSION_COOKIE));
    if (!signedIn && !(await checkPassword(c.env, String(form.get('password') ?? '')))) {
      await new Promise((r) => setTimeout(r, 1000));
      // Restart the consent flow with an error message (the query is only ever used under /authorize).
      const retry = new URLSearchParams(String(form.get('q') ?? ''));
      retry.set('rupee_error', 'Wrong password. Try again.');
      return c.redirect(`/authorize?${retry}`, 303);
    }

    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: ['expenses'] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'household',
      metadata: {},
      scope: approved.request.scope,
      props: { userId: 'household' },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  }),
);

// Anything else: static PWA assets.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
