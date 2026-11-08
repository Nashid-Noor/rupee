// MCP server: lets any MCP-capable LLM client log and query household money.
// The client's LLM chooses categories, income types and tags; the server validates and stores.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  APP_NAME,
  CATEGORIES,
  CATEGORY_LABELS,
  isTarget,
  INCOME_TYPES,
  INCOME_TYPE_LABELS,
  type Category,
  type Expense,
  type Income,
  type Summary,
  capsInput,
  expenseInput,
  expensePatch,
  formatINR,
  incomeInput,
  incomePatch,
  monthRange,
  todayIST,
} from '../shared/schema';
import type { Env } from './env';
import { addExpense, deleteExpense, listExpenses, listTags, tagBreakdown, updateExpense } from './expenses';
import { addIncome, deleteIncome, listIncome, updateIncome } from './income';
import { getSummary, setCaps } from './summary';

const CATEGORY_GUIDE = `Choose the category yourself from the description:
- "needs": essentials the household must pay for — rent/EMI, groceries, utilities (electricity, water, gas, internet, phone), fuel & commute, medicine & doctor, insurance premiums, school fees, basic household supplies.
- "wants": discretionary spending — eating out, food delivery, movies, streaming, shopping for clothes/gadgets beyond basics, travel & holidays, gifts, hobbies.
- "investment": money put into market-linked or long-term wealth — SIPs, mutual funds, stocks, PPF/NPS/EPF top-ups, gold bonds, real estate, courses/upskilling.
- "savings": money set aside safely rather than invested — transfers to a savings account, emergency fund, FDs/RDs, cash kept aside, saving up for a planned purchase.
If it is genuinely ambiguous, pick the closest fit and mention your choice so the user can correct it.`;

const INCOME_GUIDE = `Income types:
- "salary": monthly in-hand salary credited to the bank (after tax and PF deductions). Spending caps are based on this.
- "bonus": bonuses, incentives, variable pay.
- "dividend": dividends from stocks or mutual funds.
- "equity": profit/proceeds from selling stocks, mutual funds or ESOPs.
- "pf": EPF/PPF/NPS withdrawals or interest actually received.
- "interest": savings account, FD/RD interest.
- "rent": rental income.
- "other": gifts received, refunds, freelance, anything else.`;

function tagGuide(existing: string[]): string {
  const base =
    'Tags: 1–4 short lowercase tags describing what it was (e.g. "groceries", "food-delivery", "fuel", "electricity", "medical", plus a merchant like "dmart" or "swiggy" when known).';
  return existing.length
    ? `${base} Reuse existing tags where they fit instead of inventing near-duplicates. Existing tags: ${existing.join(', ')}.`
    : base;
}

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date as YYYY-MM-DD (India time). Resolve words like "yesterday" yourself.');
const tagsField = z.array(z.string()).max(10);

function expenseLine(e: Expense): string {
  const tags = e.tags.length ? ` · #${e.tags.join(' #')}` : '';
  return `${e.date} · ${formatINR(e.amount)} · ${e.category} · ${e.description}${tags} (id: ${e.id})`;
}

function incomeLine(i: Income): string {
  return `${i.date} · ${formatINR(i.amount)} · ${INCOME_TYPE_LABELS[i.type]}${i.description ? ` · ${i.description}` : ''} (id: ${i.id})`;
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError };
}

function validationError(err: z.ZodError) {
  return text(`Invalid input: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, true);
}

function capLine(s: Summary, c: Category): string | null {
  const b = s.budget?.byCategory[c];
  if (!b) return null;
  const kind = isTarget(c) ? 'target' : 'cap';
  const note = {
    ok: '',
    near: ' ⚠️ close to the cap',
    over: ' 🔴 OVER the cap',
    below: '',
    met: ' ✅ target reached',
  }[b.status];
  return `${CATEGORY_LABELS[c]}: ${formatINR(b.spent)} of ${formatINR(b.limit)} ${kind} (${b.used}%)${note}`;
}

function summaryText(s: Summary): string {
  const lines = [
    `Period ${s.from} to ${s.to}`,
    `Income: ${formatINR(s.income.total)}${
      s.income.count
        ? ` (${Object.entries(s.income.byType)
            .map(([t, v]) => `${INCOME_TYPE_LABELS[t as keyof typeof INCOME_TYPE_LABELS]} ${formatINR(v!)}`)
            .join(', ')})`
        : ''
    }`,
    `Spent: ${formatINR(s.total)} across ${s.count} expenses`,
    `Left over (income − everything spent, invested and saved): ${formatINR(s.saved)}`,
    '',
    'Spending by category:',
    ...CATEGORIES.map(
      (c) => `- ${c}: ${formatINR(s.byCategory[c].total)} (${s.byCategory[c].percent}% of spending, ${s.byCategory[c].count} entries)`,
    ),
  ];
  if (s.budget) {
    lines.push(
      '',
      `Caps (${s.caps.needs}% needs / ${s.caps.wants}% wants; targets ${s.caps.investment}% investment / ${s.caps.savings}% savings) based on in-hand salary ${formatINR(s.budget.salary)}${
        s.budget.estimated ? ` from ${s.budget.salaryMonth} (this month's salary not recorded yet — estimated)` : ''
      }:`,
      ...CATEGORIES.map((c) => `- ${capLine(s, c)}`),
    );
  } else if (s.from.endsWith('-01') && monthRange(s.from).to === s.to) {
    lines.push('', 'Caps: no salary recorded for this or last month, so caps cannot be calculated.');
  }
  return lines.join('\n');
}

export async function createMcpServer(env: Env): Promise<McpServer> {
  const existingTags = (await listTags(env.DB, 60)).map((t) => t.tag);
  const server = new McpServer(
    { name: 'rupee-flow', title: APP_NAME, version: '2.0.0' },
    {
      instructions: `${APP_NAME} is a shared household money tracker. All amounts are Indian Rupees (INR). Today's date in India is ${todayIST()}.
Use add_expense when the user mentions spending money and add_income when they mention receiving money.
Spending caps are percentages of the month's in-hand salary: needs and wants are caps (stay under), investment and savings are targets (reach them).
${CATEGORY_GUIDE}
${tagGuide(existingTags)}`,
    },
  );

  // ---- Expenses ----

  server.registerTool(
    'add_expense',
    {
      title: 'Add expense',
      description: `Record a household expense in INR. The reply includes where the category stands against this month's cap.\n\n${CATEGORY_GUIDE}\n\n${tagGuide(existingTags)}`,
      inputSchema: {
        amount: z.number().positive().describe('Amount in rupees (e.g. 450 or 129.50). Not paise.'),
        description: z.string().min(1).max(200).describe('Short description, e.g. "Dinner at Saravana Bhavan"'),
        category: z.enum(CATEGORIES).describe('needs | wants | investment | savings — decided by you per the guide'),
        tags: tagsField.optional().describe('1–4 lowercase tags, reusing existing ones where they fit. Always include them.'),
        date: dateField.optional().describe('YYYY-MM-DD. Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const parsed = expenseInput.safeParse(args);
      if (!parsed.success) return validationError(parsed.error);
      const e = await addExpense(env.DB, parsed.data, 'mcp');
      const s = await getSummary(env.DB, monthRange(e.date));
      const cap = capLine(s, e.category);
      return text(`Saved: ${expenseLine(e)}${cap ? `\nThis month — ${cap}` : ''}`);
    },
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'List expenses',
      description:
        'List expenses, newest first. Filter by date range, category, tag, text (matches description or tags), or only untagged ones.',
      inputSchema: {
        from: dateField.optional().describe('Start date (inclusive), YYYY-MM-DD'),
        to: dateField.optional().describe('End date (inclusive), YYYY-MM-DD'),
        category: z.enum(CATEGORIES).optional(),
        tag: z.string().optional().describe('Only expenses with this tag'),
        untagged: z.boolean().optional().describe('Only expenses with no tags (useful for tagging old entries)'),
        search: z.string().max(100).optional().describe('Text to match in descriptions or tags'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { items, total } = await listExpenses(env.DB, { ...args, limit: args.limit ?? 50 });
      if (!items.length) return text('No expenses found.');
      const sum = items.reduce((s, e) => s + e.amount, 0);
      return text(`${items.length} of ${total} expense(s) shown, totalling ${formatINR(sum)}:\n${items.map(expenseLine).join('\n')}`);
    },
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Update expense',
      description:
        'Correct an existing expense, or set its tags. Passing tags REPLACES all its tags. Get the id from list_expenses.',
      inputSchema: {
        id: z.string().describe('Expense id'),
        amount: z.number().positive().optional().describe('New amount in rupees'),
        description: z.string().min(1).max(200).optional(),
        category: z.enum(CATEGORIES).optional(),
        tags: tagsField.optional().describe('Full new list of tags (replaces existing)'),
        date: dateField.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const parsed = expensePatch.safeParse(patch);
      if (!parsed.success) return validationError(parsed.error);
      const e = await updateExpense(env.DB, id, parsed.data);
      return e ? text(`Updated: ${expenseLine(e)}`) : text(`No expense with id ${id}`, true);
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

  // ---- Tags ----

  server.registerTool(
    'spending_by_tag',
    {
      title: 'Spending by tag',
      description:
        'Total spending per tag over a date range, highest first — e.g. "how much on food delivery this year?" or "top tags this month". An expense with several tags counts under each of them. Also returns all known tags when called without filters.',
      inputSchema: {
        from: dateField.optional().describe('Start date (inclusive). Omit for all time.'),
        to: dateField.optional().describe('End date (inclusive). Omit for today.'),
        category: z.enum(CATEGORIES).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Max tags (default 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = await tagBreakdown(env.DB, args);
      if (!rows.length) return text('No tagged expenses in that range.');
      return text(
        `Spending by tag${args.from || args.to ? ` (${args.from ?? 'start'} to ${args.to ?? 'today'})` : ' (all time)'}:\n` +
          rows.map((r) => `- #${r.tag}: ${formatINR(r.total)} (${r.count} expenses)`).join('\n'),
      );
    },
  );

  // ---- Income ----

  server.registerTool(
    'add_income',
    {
      title: 'Add income',
      description: `Record money received, in INR.\n\n${INCOME_GUIDE}`,
      inputSchema: {
        amount: z.number().positive().describe('Amount in rupees. For salary, the in-hand amount credited.'),
        type: z.enum(INCOME_TYPES).describe('Income type — decided by you per the guide'),
        description: z.string().max(200).optional().describe('e.g. "October salary – Infosys", "HDFC Bank dividend"'),
        date: dateField.optional().describe('YYYY-MM-DD it was received. Omit for today.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const parsed = incomeInput.safeParse(args);
      if (!parsed.success) return validationError(parsed.error);
      const i = await addIncome(env.DB, parsed.data, 'mcp');
      return text(`Saved income: ${incomeLine(i)}`);
    },
  );

  server.registerTool(
    'list_income',
    {
      title: 'List income',
      description: 'List income entries, newest first. Filter by date range and type.',
      inputSchema: {
        from: dateField.optional(),
        to: dateField.optional(),
        type: z.enum(INCOME_TYPES).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { items, total } = await listIncome(env.DB, { ...args, limit: args.limit ?? 50 });
      if (!items.length) return text('No income found.');
      const sum = items.reduce((s, i) => s + i.amount, 0);
      return text(`${items.length} of ${total} income entr${total === 1 ? 'y' : 'ies'} shown, totalling ${formatINR(sum)}:\n${items.map(incomeLine).join('\n')}`);
    },
  );

  server.registerTool(
    'update_income',
    {
      title: 'Update income',
      description: 'Correct an existing income entry. Get the id from list_income.',
      inputSchema: {
        id: z.string(),
        amount: z.number().positive().optional(),
        type: z.enum(INCOME_TYPES).optional(),
        description: z.string().max(200).optional(),
        date: dateField.optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...patch }) => {
      const parsed = incomePatch.safeParse(patch);
      if (!parsed.success) return validationError(parsed.error);
      const i = await updateIncome(env.DB, id, parsed.data);
      return i ? text(`Updated income: ${incomeLine(i)}`) : text(`No income with id ${id}`, true);
    },
  );

  server.registerTool(
    'delete_income',
    {
      title: 'Delete income',
      description: 'Permanently delete an income entry by id. Confirm with the user first if there is any doubt.',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const ok = await deleteIncome(env.DB, id);
      return ok ? text(`Deleted income ${id}`) : text(`No income with id ${id}`, true);
    },
  );

  // ---- Summary & caps ----

  server.registerTool(
    'get_summary',
    {
      title: 'Monthly summary',
      description:
        'Income (by type), spending (by category), savings, and — for a whole calendar month — how needs/wants compare to their caps and investment/savings to their targets. Defaults to the current month.',
      inputSchema: {
        from: dateField.optional().describe('Start date (inclusive). Omit for start of this month.'),
        to: dateField.optional().describe('End date (inclusive). Omit for end of this month / today.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => text(summaryText(await getSummary(env.DB, { from, to }))),
  );

  server.registerTool(
    'set_caps',
    {
      title: 'Set spending caps',
      description:
        'Set the monthly split as percentages of in-hand salary: needs and wants are caps, investment and savings are targets. They must add up to 100 or less. Confirm the numbers with the user before changing them.',
      inputSchema: {
        needs: z.number().min(0).max(100),
        wants: z.number().min(0).max(100),
        investment: z.number().min(0).max(100),
        savings: z.number().min(0).max(100),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const parsed = capsInput.safeParse(args);
      if (!parsed.success) return validationError(parsed.error);
      const c = await setCaps(env.DB, parsed.data);
      return text(`Caps set: needs ${c.needs}%, wants ${c.wants}%, investment target ${c.investment}%, savings target ${c.savings}% of in-hand salary.`);
    },
  );

  return server;
}

/** Stateless Streamable HTTP handler: a fresh server + transport per request. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const server = await createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
