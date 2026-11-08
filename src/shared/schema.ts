import { z } from 'zod';

export const APP_NAME = 'Rupee Flow';

// ---- Expense categories -------------------------------------------------------

export const CATEGORIES = ['needs', 'wants', 'investment', 'savings'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Needs and wants are caps (stay under); investment and savings are targets (reach them). */
export const isTarget = (c: Category) => c === 'investment' || c === 'savings';

export const CATEGORY_LABELS: Record<Category, string> = {
  needs: 'Needs',
  wants: 'Wants',
  investment: 'Investment',
  savings: 'Savings',
};

// ---- Income types -------------------------------------------------------------

export const INCOME_TYPES = ['salary', 'bonus', 'dividend', 'equity', 'pf', 'interest', 'rent', 'other'] as const;
export type IncomeType = (typeof INCOME_TYPES)[number];

export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  salary: 'Salary',
  bonus: 'Bonus',
  dividend: 'Dividend',
  equity: 'Equity',
  pf: 'PF',
  interest: 'Interest',
  rent: 'Rent',
  other: 'Other',
};

// ---- Field validators -----------------------------------------------------------

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');

/** Amount in rupees, up to 2 decimal places, max ₹1 crore per entry. */
const amountRupees = z
  .number()
  .positive('Amount must be greater than 0')
  .max(10_000_000, 'Amount too large')
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most 2 decimal places');

/** "Food Delivery " → "food-delivery". */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

const tagList = z
  .array(z.string())
  .max(10, 'At most 10 tags')
  .transform((tags) => [...new Set(tags.map(normalizeTag).filter(Boolean))]);

// ---- Expenses -----------------------------------------------------------------

export const expenseInput = z.object({
  amount: amountRupees,
  description: z.string().trim().min(1, 'Description is required').max(200),
  category: z.enum(CATEGORIES),
  date: isoDate.optional(),
  tags: tagList.optional(),
});
export type ExpenseInput = z.input<typeof expenseInput>;
export type ExpenseData = z.output<typeof expenseInput>;

export const expensePatch = expenseInput.partial();
export type ExpensePatch = z.output<typeof expensePatch>;

export const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.enum(CATEGORIES).optional(),
  tag: z.string().transform(normalizeTag).optional(),
  untagged: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.input<typeof listQuery>;

export interface Expense {
  id: string;
  amount: number; // rupees
  description: string;
  category: Category;
  date: string; // YYYY-MM-DD
  tags: string[];
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
}

// ---- Income -------------------------------------------------------------------

export const incomeInput = z.object({
  amount: amountRupees,
  type: z.enum(INCOME_TYPES),
  description: z.string().trim().max(200).default(''),
  date: isoDate.optional(),
});
export type IncomeInput = z.input<typeof incomeInput>;
export type IncomeData = z.output<typeof incomeInput>;

export const incomePatch = z.object({
  amount: amountRupees.optional(),
  type: z.enum(INCOME_TYPES).optional(),
  description: z.string().trim().max(200).optional(),
  date: isoDate.optional(),
});
export type IncomePatch = z.output<typeof incomePatch>;

export const incomeListQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(INCOME_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type IncomeListQuery = z.input<typeof incomeListQuery>;

export interface Income {
  id: string;
  amount: number;
  type: IncomeType;
  description: string;
  date: string;
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
}

// ---- Budget caps (percent of in-hand salary) ----------------------------------------

const percent = z.number().min(0).max(100);
export const capsInput = z
  // savings defaults to 0 so caps saved before it existed still load.
  .object({ needs: percent, wants: percent, investment: percent, savings: percent.default(0) })
  .refine((c) => c.needs + c.wants + c.investment + c.savings <= 100, 'Percentages must add up to 100 or less');
export type Caps = z.infer<typeof capsInput>;
export const DEFAULT_CAPS: Caps = { needs: 50, wants: 30, investment: 10, savings: 10 };

export type CapStatus = 'ok' | 'near' | 'over' | 'below' | 'met';

export interface CategoryBudget {
  percent: number;
  limit: number; // rupees
  spent: number;
  used: number; // % of limit
  status: CapStatus;
}

export interface Budget {
  salary: number; // in-hand salary the caps are based on
  salaryMonth: string; // YYYY-MM the salary came from
  estimated: boolean; // true when using last month's salary
  byCategory: Record<Category, CategoryBudget>;
}

// ---- Summary ------------------------------------------------------------------

export const rangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export interface Summary {
  from: string;
  to: string;
  total: number; // total spent
  count: number;
  byCategory: Record<Category, { total: number; count: number; percent: number }>;
  income: { total: number; count: number; byType: Partial<Record<IncomeType, number>> };
  saved: number; // income − spent
  caps: Caps;
  /** Present for whole calendar months that have (this or last month's) salary. */
  budget: Budget | null;
}

export interface TagTotal {
  tag: string;
  total: number;
  count: number;
}

// ---- Date & money helpers -----------------------------------------------------------

/** Today's date in India (YYYY-MM-DD). */
export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/** First and last day of the month containing `date` (YYYY-MM-DD). */
export function monthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** Month start shifted by `delta` months. */
export function shiftMonth(monthStart: string, delta: number): string {
  const [y, m] = monthStart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}
