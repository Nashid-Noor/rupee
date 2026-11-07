// Service layer: the only code that touches the expenses table.
// Both the REST API (PWA) and the MCP tools call these functions.
import {
  CATEGORIES,
  type Category,
  type Expense,
  type ExpenseInput,
  type ExpensePatch,
  type ListQuery,
  type Summary,
  monthRange,
  todayIST,
} from '../shared/schema';

interface Row {
  id: string;
  amount_paise: number;
  description: string;
  category: Category;
  spent_on: string;
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);
const fromPaise = (paise: number) => paise / 100;

function toExpense(r: Row): Expense {
  return {
    id: r.id,
    amount: fromPaise(r.amount_paise),
    description: r.description,
    category: r.category,
    date: r.spent_on,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function addExpense(db: D1Database, input: ExpenseInput, source: 'web' | 'mcp'): Promise<Expense> {
  const row = await db
    .prepare(
      `INSERT INTO expenses (id, amount_paise, description, category, spent_on, source)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(crypto.randomUUID(), toPaise(input.amount), input.description, input.category, input.date ?? todayIST(), source)
    .first<Row>();
  return toExpense(row!);
}

export async function getExpense(db: D1Database, id: string): Promise<Expense | null> {
  const row = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first<Row>();
  return row ? toExpense(row) : null;
}

export async function listExpenses(db: D1Database, q: ListQuery): Promise<{ items: Expense[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.from) (where.push('spent_on >= ?'), args.push(q.from));
  if (q.to) (where.push('spent_on <= ?'), args.push(q.to));
  if (q.category) (where.push('category = ?'), args.push(q.category));
  if (q.search) (where.push("description LIKE ? ESCAPE '\\'"), args.push(`%${q.search.replace(/[\\%_]/g, '\\$&')}%`));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count] = await db.batch([
    db
      .prepare(`SELECT * FROM expenses ${clause} ORDER BY spent_on DESC, created_at DESC LIMIT ? OFFSET ?`)
      .bind(...args, q.limit, q.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM expenses ${clause}`).bind(...args),
  ]);
  return {
    items: (rows.results as Row[]).map(toExpense),
    total: (count.results[0] as { n: number }).n,
  };
}

export async function updateExpense(db: D1Database, id: string, patch: ExpensePatch): Promise<Expense | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.amount !== undefined) (sets.push('amount_paise = ?'), args.push(toPaise(patch.amount)));
  if (patch.description !== undefined) (sets.push('description = ?'), args.push(patch.description));
  if (patch.category !== undefined) (sets.push('category = ?'), args.push(patch.category));
  if (patch.date !== undefined) (sets.push('spent_on = ?'), args.push(patch.date));
  if (!sets.length) return getExpense(db, id);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const row = await db
    .prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...args, id)
    .first<Row>();
  return row ? toExpense(row) : null;
}

export async function deleteExpense(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  return res.meta.changes > 0;
}

/** Totals per category. Defaults to the current month (India time). */
export async function getSummary(db: D1Database, range: { from?: string; to?: string }): Promise<Summary> {
  const month = monthRange(todayIST());
  const from = range.from ?? month.from;
  const to = range.to ?? (range.from ? todayIST() : month.to);
  const { results } = await db
    .prepare(
      `SELECT category, SUM(amount_paise) AS paise, COUNT(*) AS n
       FROM expenses WHERE spent_on >= ? AND spent_on <= ? GROUP BY category`,
    )
    .bind(from, to)
    .all<{ category: Category; paise: number; n: number }>();

  const totalPaise = results.reduce((s, r) => s + r.paise, 0);
  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => {
      const r = results.find((x) => x.category === c);
      const paise = r?.paise ?? 0;
      return [
        c,
        {
          total: fromPaise(paise),
          count: r?.n ?? 0,
          percent: totalPaise ? Math.round((paise / totalPaise) * 1000) / 10 : 0,
        },
      ];
    }),
  ) as Summary['byCategory'];

  return {
    from,
    to,
    total: fromPaise(totalPaise),
    count: results.reduce((s, r) => s + r.n, 0),
    byCategory,
  };
}
