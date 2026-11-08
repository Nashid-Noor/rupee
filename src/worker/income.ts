// Income entries. The only code that touches the incomes table.
import type { Income, IncomeData, IncomeListQuery, IncomePatch, IncomeType } from '../shared/schema';
import { incomeListQuery, todayIST } from '../shared/schema';
import { fromPaise, toPaise } from './expenses';

interface Row {
  id: string;
  amount_paise: number;
  type: IncomeType;
  description: string;
  received_on: string;
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
}

function toIncome(r: Row): Income {
  return {
    id: r.id,
    amount: fromPaise(r.amount_paise),
    type: r.type,
    description: r.description,
    date: r.received_on,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function addIncome(db: D1Database, input: IncomeData, source: 'web' | 'mcp'): Promise<Income> {
  const row = await db
    .prepare(
      `INSERT INTO incomes (id, amount_paise, type, description, received_on, source)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(crypto.randomUUID(), toPaise(input.amount), input.type, input.description, input.date ?? todayIST(), source)
    .first<Row>();
  return toIncome(row!);
}

export async function listIncome(db: D1Database, query: IncomeListQuery): Promise<{ items: Income[]; total: number }> {
  const q = incomeListQuery.parse(query);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.from) (where.push('received_on >= ?'), args.push(q.from));
  if (q.to) (where.push('received_on <= ?'), args.push(q.to));
  if (q.type) (where.push('type = ?'), args.push(q.type));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await db.batch([
    db
      .prepare(`SELECT * FROM incomes ${clause} ORDER BY received_on DESC, created_at DESC LIMIT ? OFFSET ?`)
      .bind(...args, q.limit, q.offset),
    db.prepare(`SELECT COUNT(*) AS n FROM incomes ${clause}`).bind(...args),
  ]);
  return {
    items: (rows.results as Row[]).map(toIncome),
    total: (count.results[0] as { n: number }).n,
  };
}

export async function updateIncome(db: D1Database, id: string, patch: IncomePatch): Promise<Income | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.amount !== undefined) (sets.push('amount_paise = ?'), args.push(toPaise(patch.amount)));
  if (patch.type !== undefined) (sets.push('type = ?'), args.push(patch.type));
  if (patch.description !== undefined) (sets.push('description = ?'), args.push(patch.description));
  if (patch.date !== undefined) (sets.push('received_on = ?'), args.push(patch.date));
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const row = await db
    .prepare(`UPDATE incomes SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...args, id)
    .first<Row>();
  return row ? toIncome(row) : null;
}

export async function deleteIncome(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM incomes WHERE id = ?').bind(id).run();
  return res.meta.changes > 0;
}
