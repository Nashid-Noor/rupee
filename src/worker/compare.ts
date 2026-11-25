// Income vs spending for the last N weeks / months / years, in two grouped queries.
import {
  DEFAULT_COMPARE_COUNT,
  type Category,
  type CompareRow,
  type ComparePeriod,
  type WeekBreakdown,
  type WeeklyComparison,
  monthRange,
  periodRange,
  shiftPeriod,
  shiftWeek,
  todayIST,
  weekRange,
} from '../shared/schema';
import { fromPaise } from './expenses';

/** SQL expression that maps a date column to the start date of its period. */
const bucketSql = (period: ComparePeriod, col: string) =>
  period === 'week'
    ? `date(${col}, '-6 days', 'weekday 1')` // Monday of the week containing the date
    : period === 'month'
      ? `substr(${col}, 1, 7) || '-01'`
      : `substr(${col}, 1, 4) || '-01-01'`;

/** Oldest to newest; the last row is the current period. */
export async function getComparison(
  db: D1Database,
  period: ComparePeriod,
  count = DEFAULT_COMPARE_COUNT[period],
): Promise<CompareRow[]> {
  const today = todayIST();
  const current = periodRange(period, today);
  const starts = Array.from({ length: count }, (_, i) => shiftPeriod(period, current.from, i - (count - 1)));
  const from = starts[0];
  const to = current.to;

  const [spend, income] = await db.batch([
    db
      .prepare(
        `SELECT ${bucketSql(period, 'spent_on')} AS b,
                SUM(CASE WHEN category IN ('investment', 'savings') THEN 0 ELSE amount_paise END) AS spent,
                SUM(CASE WHEN category = 'investment' THEN amount_paise ELSE 0 END) AS investment,
                SUM(CASE WHEN category = 'savings' THEN amount_paise ELSE 0 END) AS savings
         FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY b`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT ${bucketSql(period, 'received_on')} AS b, SUM(amount_paise) AS income
         FROM incomes WHERE received_on BETWEEN ? AND ? GROUP BY b`,
      )
      .bind(from, to),
  ]);
  const spendBy = new Map((spend.results as { b: string; spent: number; investment: number; savings: number }[]).map((r) => [r.b, r]));
  const incomeBy = new Map((income.results as { b: string; income: number }[]).map((r) => [r.b, r.income]));

  return starts.map((start) => {
    const incomePaise = incomeBy.get(start) ?? 0;
    const spentPaise = spendBy.get(start)?.spent ?? 0;
    const investmentPaise = spendBy.get(start)?.investment ?? 0;
    const savingsPaise = spendBy.get(start)?.savings ?? 0;
    return {
      ...periodRange(period, start),
      income: fromPaise(incomePaise),
      spent: fromPaise(spentPaise),
      investment: fromPaise(investmentPaise),
      savings: fromPaise(savingsPaise),
      leftOver: fromPaise(incomePaise - spentPaise - investmentPaise - savingsPaise),
      partial: start === current.from,
    };
  });
}

/** One month's income plus spending per week, by category. Weeks are cut at the month edges. */
export async function getWeeklyComparison(db: D1Database, date?: string): Promise<WeeklyComparison> {
  const today = todayIST();
  const month = monthRange(date ?? today);

  const [spend, income] = await db.batch([
    db
      .prepare(
        `SELECT ${bucketSql('week', 'spent_on')} AS b, category, SUM(amount_paise) AS paise
         FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY b, category`,
      )
      .bind(month.from, month.to),
    db.prepare('SELECT COALESCE(SUM(amount_paise), 0) AS p FROM incomes WHERE received_on BETWEEN ? AND ?').bind(month.from, month.to),
  ]);
  const rows = spend.results as { b: string; category: Category; paise: number }[];

  const weeks: WeekBreakdown[] = [];
  for (let start = weekRange(month.from).from; start <= month.to; start = shiftWeek(start, 1)) {
    const week = weekRange(start);
    const paise = (c: Category) => fromPaise(rows.find((r) => r.b === start && r.category === c)?.paise ?? 0);
    weeks.push({
      from: week.from < month.from ? month.from : week.from,
      to: week.to > month.to ? month.to : week.to,
      needs: paise('needs'),
      wants: paise('wants'),
      investment: paise('investment'),
      savings: paise('savings'),
      partial: week.from <= today && today <= week.to,
    });
  }
  return { month: month.from, income: fromPaise((income.results[0] as { p: number }).p), weeks };
}
