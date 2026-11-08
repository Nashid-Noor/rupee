# Rupee Flow — household money tracker

Track shared household **income** (salary, bonus, dividends, equity, PF, interest, rent) and **spending** as **needs**, **wants**, **investment** or **savings**, with tags and monthly caps set as a percentage of in-hand salary. Two ways in:

- **PWA**: install it on your phone's home screen and add expenses with a simple form.
- **Any AI assistant over MCP**: say *"spent ₹450 on dinner with friends"* or *"salary of ₹1.2L came in"* and the assistant logs it, picking the category and tags.

**Caps:** set percentages in Settings (default needs 50 / wants 30 / investment 10 / savings 10). Each month, needs and wants are capped at that share of the month's in-hand salary, and investment and savings are targets to reach. If this month's salary isn't recorded yet, last month's is used (marked *estimated*). Caps warn, never block.

Everything runs as one Cloudflare Worker on the free plan.

```
PWA ── /api/* (session cookie) ──┐
                                 ├─► service layer (expenses / income / summary) ─► D1 (SQLite)
AI  ── /mcp   (OAuth or token) ───┘
```

| Path | What |
|---|---|
| `src/shared/schema.ts` | Validation (Zod), shared by the API, MCP tools and form |
| `src/worker/expenses.ts` | Expenses and tags |
| `src/worker/income.ts` | Income |
| `src/worker/summary.ts` | Caps settings, monthly summary and budget |
| `src/worker/mcp.ts` | MCP tools: add/list/update/delete for expenses and income, `spending_by_tag`, `get_summary`, `set_caps` |
| `src/worker/app.ts` | REST API, login, OAuth consent page |
| `src/worker/index.ts` | Entry point; `OAuthProvider` protects `/mcp` |
| `web/` | React PWA |
| `migrations/` | D1 schema |

Amounts are stored as whole paise to avoid rounding errors. Dates are India time.

## Run locally

```sh
npm install
npm run db:migrate:local
npm run dev            # builds the PWA, serves everything on http://localhost:8787
```

The local password is in `.dev.vars` (`local-dev-password`). For frontend hot-reload, also run `npm run dev:web` and open http://localhost:5173.

## Deploy to Cloudflare (free)

1. Create a free account at https://dash.cloudflare.com/sign-up, then:
   ```sh
   npx wrangler login
   ```
2. Create the database and KV store, and paste each printed id into `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create rupee                 # → d1_databases[0].database_id
   npx wrangler kv namespace create OAUTH_KV    # → kv_namespaces[0].id
   ```
3. Create the tables (run again after pulling changes that add a migration):
   ```sh
   npm run db:migrate:remote
   ```
4. Set the secrets:
   ```sh
   npx wrangler secret put APP_PASSWORD     # household password, 10+ chars; use a strong one
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   ```
5. Deploy, then put the printed `https://rupee.<you>.workers.dev` URL into `vars.PUBLIC_URL` in `wrangler.jsonc` and deploy again:
   ```sh
   npm run deploy
   ```

Sign out every device: change `SESSION_SECRET`. Change the password: run `wrangler secret put APP_PASSWORD` again.

## Install the app on a phone

Open your `workers.dev` URL, sign in, then:
- **Android (Chrome):** menu → *Add to Home screen / Install app*
- **iPhone (Safari):** Share → *Add to Home Screen*

## Connect an AI assistant

The MCP server URL is `https://rupee.<you>.workers.dev/mcp` (also shown in the app under ⚙️ Settings).

**Apps that sign in with OAuth** (Claude web/desktop/mobile, ChatGPT and others): add a custom connector / remote MCP server with that URL. A Rupee page opens; enter the household password and tap **Allow**. Whether custom connectors are available depends on the app and your plan with it.

**Apps that take a URL and a header** (Claude Code, Cursor, VS Code…): create a token in ⚙️ Settings, then configure the header `Authorization: Bearer <token>`. For example, with Claude Code:

```sh
claude mcp add --transport http rupee https://rupee.<you>.workers.dev/mcp \
  --header "Authorization: Bearer rupee_xxx"
```

Tokens can be revoked from Settings at any time.
