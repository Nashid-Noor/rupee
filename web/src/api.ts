import type {
  Caps,
  Expense,
  ExpenseInput,
  Income,
  IncomeInput,
  Summary,
  TagTotal,
} from '../../src/shared/schema';

export class AuthError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') throw new AuthError('Not signed in');
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  session: () => req<{ ok: true; mcpUrl: string }>('/api/session'),
  login: (password: string) => req<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req('/api/logout', { method: 'POST', body: '{}' }),

  list: (from: string, to: string) =>
    req<{ items: Expense[]; total: number }>(`/api/expenses?${qs({ from, to, limit: '500' })}`),
  add: (input: ExpenseInput) => req<Expense>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<ExpenseInput>) =>
    req<Expense>(`/api/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => req(`/api/expenses/${id}`, { method: 'DELETE' }),

  incomes: (from: string, to: string) =>
    req<{ items: Income[]; total: number }>(`/api/incomes?${qs({ from, to, limit: '500' })}`),
  addIncome: (input: IncomeInput) => req<Income>('/api/incomes', { method: 'POST', body: JSON.stringify(input) }),
  updateIncome: (id: string, patch: Partial<IncomeInput>) =>
    req<Income>(`/api/incomes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeIncome: (id: string) => req(`/api/incomes/${id}`, { method: 'DELETE' }),

  summary: (from: string, to: string) => req<Summary>(`/api/summary?${qs({ from, to })}`),
  tags: () => req<{ tag: string; count: number }[]>('/api/tags'),
  tagBreakdown: (from: string, to: string) => req<TagTotal[]>(`/api/tags/breakdown?${qs({ from, to })}`),

  caps: () => req<Caps>('/api/caps'),
  setCaps: (caps: Caps) => req<Caps>('/api/caps', { method: 'PUT', body: JSON.stringify(caps) }),

  tokens: () => req<ApiToken[]>('/api/tokens'),
  createToken: (name: string) =>
    req<{ token: string; info: ApiToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteToken: (id: string) => req(`/api/tokens/${id}`, { method: 'DELETE' }),
};
