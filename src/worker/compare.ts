// Income vs spending for the last N weeks / months / years, in two grouped queries.
import {
  DEFAULT_COMPARE_COUNT,
  type CompareRow,
  type ComparePeriod,
  periodRange,
  shiftPeriod,
  todayIST,
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
                SUM(CASE WHEN category IN ('investment', 'savings') THEN amount_paise ELSE 0 END) AS invested
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
  const spendBy = new Map((spend.results as { b: string; spent: number; invested: number }[]).map((r) => [r.b, r]));
  const incomeBy = new Map((income.results as { b: string; income: number }[]).map((r) => [r.b, r.income]));

  return starts.map((start) => {
    const incomePaise = incomeBy.get(start) ?? 0;
    const spentPaise = spendBy.get(start)?.spent ?? 0;
    const investedPaise = spendBy.get(start)?.invested ?? 0;
    return {
      ...periodRange(period, start),
      income: fromPaise(incomePaise),
      spent: fromPaise(spentPaise),
      invested: fromPaise(investedPaise),
      saved: fromPaise(incomePaise - spentPaise - investedPaise),
      partial: start === current.from,
    };
  });
}
