// Expenses + their tags. The only code that touches the expenses / expense_tags tables.
import type { Category, Expense, ExpenseData, ExpensePatch, ListQuery, TagTotal } from '../shared/schema';
import { listQuery, todayIST } from '../shared/schema';

interface Row {
  id: string;
  amount_paise: number;
  description: string;
  category: Category;
  spent_on: string;
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
  tags: string | null; // comma-joined
}

export const toPaise = (rupees: number) => Math.round(rupees * 100);
export const fromPaise = (paise: number) => paise / 100;

const SELECT = `SELECT e.*, (SELECT group_concat(tag, ',') FROM (SELECT tag FROM expense_tags t WHERE t.expense_id = e.id ORDER BY tag)) AS tags FROM expenses e`;

function toExpense(r: Row): Expense {
  return {
    id: r.id,
    amount: fromPaise(r.amount_paise),
    description: r.description,
    category: r.category,
    date: r.spent_on,
    tags: r.tags ? r.tags.split(',') : [],
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function tagInserts(db: D1Database, id: string, tags: string[]) {
  return tags.map((t) => db.prepare('INSERT OR IGNORE INTO expense_tags (expense_id, tag) VALUES (?, ?)').bind(id, t));
}

export async function getExpense(db: D1Database, id: string): Promise<Expense | null> {
  const row = await db.prepare(`${SELECT} WHERE e.id = ?`).bind(id).first<Row>();
  return row ? toExpense(row) : null;
}

export async function addExpense(db: D1Database, input: ExpenseData, source: 'web' | 'mcp'): Promise<Expense> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare('INSERT INTO expenses (id, amount_paise, description, category, spent_on, source) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, toPaise(input.amount), input.description, input.category, input.date ?? todayIST(), source),
    ...tagInserts(db, id, input.tags ?? []),
  ]);
  return (await getExpense(db, id))!;
}

export async function listExpenses(db: D1Database, query: ListQuery): Promise<{ items: Expense[]; total: number }> {
  const q = listQuery.parse(query);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.from) (where.push('e.spent_on >= ?'), args.push(q.from));
  if (q.to) (where.push('e.spent_on <= ?'), args.push(q.to));
  if (q.category) (where.push('e.category = ?'), args.push(q.category));
  if (q.tag) (where.push('EXISTS (SELECT 1 FROM expense_tags t WHERE t.expense_id = e.id AND t.tag = ?)'), args.push(q.tag));
  if (q.untagged) where.push('NOT EXISTS (SELECT 1 FROM expense_tags t WHERE t.expense_id = e.id)');
  if (q.search) {
    const like = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
    where.push(
      "(e.description LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM expense_tags t WHERE t.expense_id = e.id AND t.tag LIKE ? ESCAPE '\\'))",
    );
    args.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count] = await db.batch([
    db.prepare(`${SELECT} ${clause} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT ? OFFSET ?`).bind(...args, q.limit, q.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM expenses e ${clause}`).bind(...args),
  ]);
  return {
    items: (rows.results as Row[]).map(toExpense),
    total: (count.results[0] as { n: number }).n,
  };
}

/** `patch.tags`, when given, replaces the expense's tags. */
export async function updateExpense(db: D1Database, id: string, patch: ExpensePatch): Promise<Expense | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.amount !== undefined) (sets.push('amount_paise = ?'), args.push(toPaise(patch.amount)));
  if (patch.description !== undefined) (sets.push('description = ?'), args.push(patch.description));
  if (patch.category !== undefined) (sets.push('category = ?'), args.push(patch.category));
  if (patch.date !== undefined) (sets.push('spent_on = ?'), args.push(patch.date));
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  const exists = await db.prepare('SELECT 1 FROM expenses WHERE id = ?').bind(id).first();
  if (!exists) return null;
  await db.batch([
    db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id),
    ...(patch.tags !== undefined
      ? [db.prepare('DELETE FROM expense_tags WHERE expense_id = ?').bind(id), ...tagInserts(db, id, patch.tags)]
      : []),
  ]);
  return getExpense(db, id);
}

export async function deleteExpense(db: D1Database, id: string): Promise<boolean> {
  const [, res] = await db.batch([
    db.prepare('DELETE FROM expense_tags WHERE expense_id = ?').bind(id),
    db.prepare('DELETE FROM expenses WHERE id = ?').bind(id),
  ]);
  return res.meta.changes > 0;
}

/** All tags ever used, most used first. */
export async function listTags(db: D1Database, limit = 100): Promise<{ tag: string; count: number }[]> {
  const { results } = await db
    .prepare('SELECT tag, COUNT(*) AS count FROM expense_tags GROUP BY tag ORDER BY count DESC, tag LIMIT ?')
    .bind(limit)
    .all<{ tag: string; count: number }>();
  return results;
}

/** Spending per tag in a range. An expense with several tags counts under each. */
export async function tagBreakdown(
  db: D1Database,
  q: { from?: string; to?: string; category?: Category; limit?: number },
): Promise<TagTotal[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.from) (where.push('e.spent_on >= ?'), args.push(q.from));
  if (q.to) (where.push('e.spent_on <= ?'), args.push(q.to));
  if (q.category) (where.push('e.category = ?'), args.push(q.category));
  const { results } = await db
    .prepare(
      `SELECT t.tag, SUM(e.amount_paise) AS paise, COUNT(*) AS n
       FROM expense_tags t JOIN expenses e ON e.id = t.expense_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY t.tag ORDER BY paise DESC LIMIT ?`,
    )
    .bind(...args, q.limit ?? 20)
    .all<{ tag: string; paise: number; n: number }>();
  return results.map((r) => ({ tag: r.tag, total: fromPaise(r.paise), count: r.n }));
}
