// Caps settings and the monthly summary (income, spending, savings, budget vs caps).
import {
  CATEGORIES,
  DEFAULT_CAPS,
  type Budget,
  type CapStatus,
  type Caps,
  type Category,
  type IncomeType,
  type Summary,
  capsInput,
  isTarget,
  monthRange,
  shiftMonth,
  todayIST,
} from '../shared/schema';
import { fromPaise } from './expenses';

const CAPS_KEY = 'caps';
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getCaps(db: D1Database): Promise<Caps> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(CAPS_KEY).first<{ value: string }>();
  if (!row) return DEFAULT_CAPS;
  const parsed = capsInput.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : DEFAULT_CAPS;
}

export async function setCaps(db: D1Database, caps: Caps): Promise<Caps> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(CAPS_KEY, JSON.stringify(caps))
    .run();
  return caps;
}

function statusFor(category: Category, used: number): CapStatus {
  if (isTarget(category)) return used >= 100 ? 'met' : 'below';
  if (used > 100) return 'over';
  if (used >= 85) return 'near';
  return 'ok';
}

async function salaryPaise(db: D1Database, monthStart: string): Promise<number> {
  const { from, to } = monthRange(monthStart);
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_paise), 0) AS p FROM incomes WHERE type = 'salary' AND received_on BETWEEN ? AND ?")
    .bind(from, to)
    .first<{ p: number }>();
  return row?.p ?? 0;
}

/** Defaults to the current month (India time). */
export async function getSummary(db: D1Database, range: { from?: string; to?: string }): Promise<Summary> {
  const month = monthRange(todayIST());
  const from = range.from ?? month.from;
  const to = range.to ?? (range.from ? todayIST() : month.to);

  const [spend, income] = await db.batch([
    db
      .prepare(
        `SELECT category, SUM(amount_paise) AS paise, COUNT(*) AS n
         FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY category`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT type, SUM(amount_paise) AS paise, COUNT(*) AS n
         FROM incomes WHERE received_on BETWEEN ? AND ? GROUP BY type`,
      )
      .bind(from, to),
  ]);
  const spendRows = spend.results as { category: Category; paise: number; n: number }[];
  const incomeRows = income.results as { type: IncomeType; paise: number; n: number }[];

  const spentPaise = spendRows.reduce((s, r) => s + r.paise, 0);
  const incomePaise = incomeRows.reduce((s, r) => s + r.paise, 0);
  const catPaise = (c: Category) => spendRows.find((r) => r.category === c)?.paise ?? 0;

  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => {
      const r = spendRows.find((x) => x.category === c);
      return [
        c,
        {
          total: fromPaise(r?.paise ?? 0),
          count: r?.n ?? 0,
          percent: spentPaise ? round1(((r?.paise ?? 0) / spentPaise) * 100) : 0,
        },
      ];
    }),
  ) as Summary['byCategory'];

  const caps = await getCaps(db);

  // Budget only makes sense for one whole calendar month.
  let budget: Budget | null = null;
  if (from.endsWith('-01') && monthRange(from).to === to) {
    let salary = incomeRows.find((r) => r.type === 'salary')?.paise ?? 0;
    let salaryMonth = from;
    if (!salary) {
      salaryMonth = shiftMonth(from, -1);
      salary = await salaryPaise(db, salaryMonth);
    }
    if (salary) {
      budget = {
        salary: fromPaise(salary),
        salaryMonth: salaryMonth.slice(0, 7),
        estimated: salaryMonth !== from,
        byCategory: Object.fromEntries(
          CATEGORIES.map((c) => {
            const limitPaise = Math.round((salary * caps[c]) / 100);
            const spent = catPaise(c);
            const used = limitPaise ? round1((spent / limitPaise) * 100) : spent ? 999 : isTarget(c) ? 100 : 0;
            return [
              c,
              {
                percent: caps[c],
                limit: round2(fromPaise(limitPaise)),
                spent: fromPaise(spent),
                used,
                status: statusFor(c, used),
              },
            ];
          }),
        ) as Budget['byCategory'],
      };
    }
  }

  return {
    from,
    to,
    total: fromPaise(spentPaise),
    count: spendRows.reduce((s, r) => s + r.n, 0),
    byCategory,
    income: {
      total: fromPaise(incomePaise),
      count: incomeRows.reduce((s, r) => s + r.n, 0),
      byType: Object.fromEntries(incomeRows.map((r) => [r.type, fromPaise(r.paise)])),
    },
    saved: fromPaise(incomePaise - spentPaise),
    caps,
    budget,
  };
}
