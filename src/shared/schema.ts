import { z } from 'zod';

export const CATEGORIES = ['needs', 'wants', 'investment'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  needs: 'Needs',
  wants: 'Wants',
  investment: 'Investment',
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');

/** Amount in rupees, up to 2 decimal places, max ₹1 crore per entry. */
const amountRupees = z
  .number()
  .positive('Amount must be greater than 0')
  .max(10_000_000, 'Amount too large')
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most 2 decimal places');

export const expenseInput = z.object({
  amount: amountRupees,
  description: z.string().trim().min(1, 'Description is required').max(200),
  category: z.enum(CATEGORIES),
  date: isoDate.optional(),
});
export type ExpenseInput = z.infer<typeof expenseInput>;

export const expensePatch = expenseInput.partial();
export type ExpensePatch = z.infer<typeof expensePatch>;

export const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.enum(CATEGORIES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuery>;

export const rangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export interface Expense {
  id: string;
  amount: number; // rupees
  description: string;
  category: Category;
  date: string; // YYYY-MM-DD
  source: 'web' | 'mcp';
  created_at: string;
  updated_at: string | null;
}

export interface Summary {
  from: string;
  to: string;
  total: number;
  count: number;
  byCategory: Record<Category, { total: number; count: number; percent: number }>;
}

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

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}
