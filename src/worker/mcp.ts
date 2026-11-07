// MCP server: lets any MCP-capable LLM client log and query household expenses.
// The client's LLM chooses the category; the server only validates and stores.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { CATEGORIES, expenseInput, expensePatch, formatINR, todayIST, type Expense } from '../shared/schema';
import { addExpense, deleteExpense, getSummary, listExpenses, updateExpense } from './expenses';
import type { Env } from './env';

const CATEGORY_GUIDE = `Choose the category yourself from the description:
- "needs": essentials the household must pay for — rent/EMI, groceries, utilities (electricity, water, gas, internet, phone), fuel & commute, medicine & doctor, insurance premiums, school fees, basic household supplies.
- "wants": discretionary spending — eating out, food delivery, movies, streaming, shopping for clothes/gadgets beyond basics, travel & holidays, gifts, hobbies.
- "investment": money put towards future wealth — SIPs, mutual funds, stocks, FDs/RDs, PPF/NPS/EPF top-ups, gold bonds, courses/upskilling.
If it is genuinely ambiguous, pick the closest fit and mention your choice so the user can correct it.`;

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date of the expense as YYYY-MM-DD (India time). Resolve words like "yesterday" yourself.');

function line(e: Expense): string {
  return `${e.date} · ${formatINR(e.amount)} · ${e.category} · ${e.description} (id: ${e.id})`;
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError };
}

function validationError(err: z.ZodError) {
  return text(`Invalid input: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, true);
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'rupee', version: '1.0.0' },
    {
      instructions: `Rupee is a shared household expense tracker. All amounts are Indian Rupees (INR). Today's date in India is ${todayIST()}.
Use add_expense when the user mentions spending money. ${CATEGORY_GUIDE}`,
    },
  );

  server.registerTool(
    'add_expense',
    {
      title: 'Add expense',
      description: `Record a household expense in INR.\n\n${CATEGORY_GUIDE}`,
      inputSchema: {
        amount: z.number().positive().describe('Amount in rupees (e.g. 450 or 129.50). Not paise.'),
        description: z.string().min(1).max(200).describe('Short description, e.g. "Dinner at Saravana Bhavan"'),
        category: z.enum(CATEGORIES).describe('needs | wants | investment — decided by you per the guide'),
        date: dateField.optional().describe('YYYY-MM-DD. Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const parsed = expenseInput.safeParse(args);
      if (!parsed.success) return validationError(parsed.error);
      const e = await addExpense(env.DB, parsed.data, 'mcp');
      return text(`Saved: ${line(e)}`);
    },
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'List expenses',
      description: 'List expenses, newest first. Filter by date range, category, or text in the description.',
      inputSchema: {
        from: dateField.optional().describe('Start date (inclusive), YYYY-MM-DD'),
        to: dateField.optional().describe('End date (inclusive), YYYY-MM-DD'),
        category: z.enum(CATEGORIES).optional(),
        search: z.string().max(100).optional().describe('Text to match in descriptions'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, category, search, limit }) => {
      const { items, total } = await listExpenses(env.DB, {
        from,
        to,
        category,
        search,
        limit: limit ?? 50,
        offset: 0,
      });
      if (!items.length) return text('No expenses found.');
      const sum = items.reduce((s, e) => s + e.amount, 0);
      return text(
        `${items.length} of ${total} expense(s), totalling ${formatINR(sum)} shown:\n` + items.map(line).join('\n'),
      );
    },
  );

  server.registerTool(
    'get_summary',
    {
      title: 'Spending summary',
      description:
        'Total spending split into needs / wants / investment for a date range. Defaults to the current month.',
      inputSchema: {
        from: dateField.optional().describe('Start date (inclusive). Omit for start of this month.'),
        to: dateField.optional().describe('End date (inclusive). Omit for end of this month / today.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const s = await getSummary(env.DB, { from, to });
      const rows = CATEGORIES.map(
        (c) => `- ${c}: ${formatINR(s.byCategory[c].total)} (${s.byCategory[c].percent}%, ${s.byCategory[c].count} entries)`,
      );
      return text(`Spending ${s.from} to ${s.to}: ${formatINR(s.total)} across ${s.count} entries\n${rows.join('\n')}`);
    },
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Update expense',
      description: 'Correct an existing expense. Get the id from list_expenses or from add_expense output.',
      inputSchema: {
        id: z.string().describe('Expense id'),
        amount: z.number().positive().optional().describe('New amount in rupees'),
        description: z.string().min(1).max(200).optional(),
        category: z.enum(CATEGORIES).optional(),
        date: dateField.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const parsed = expensePatch.safeParse(patch);
      if (!parsed.success) return validationError(parsed.error);
      const e = await updateExpense(env.DB, id, parsed.data);
      return e ? text(`Updated: ${line(e)}`) : text(`No expense with id ${id}`, true);
    },
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Delete expense',
      description: 'Permanently delete an expense by id. Confirm with the user first if there is any doubt.',
      inputSchema: { id: z.string().describe('Expense id') },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const ok = await deleteExpense(env.DB, id);
      return ok ? text(`Deleted expense ${id}`) : text(`No expense with id ${id}`, true);
    },
  );

  return server;
}

/** Stateless Streamable HTTP handler: a fresh server + transport per request. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const server = createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
