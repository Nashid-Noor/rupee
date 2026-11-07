import type { Expense, ExpenseInput, ExpensePatch, Summary } from '../../src/shared/schema';

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

export const api = {
  session: () => req<{ ok: true; mcpUrl: string }>('/api/session'),
  login: (password: string) => req<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req('/api/logout', { method: 'POST', body: '{}' }),

  list: (from: string, to: string) =>
    req<{ items: Expense[]; total: number }>(`/api/expenses?${new URLSearchParams({ from, to, limit: '500' })}`),
  summary: (from: string, to: string) => req<Summary>(`/api/summary?${new URLSearchParams({ from, to })}`),
  add: (input: ExpenseInput) => req<Expense>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: ExpensePatch) =>
    req<Expense>(`/api/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => req(`/api/expenses/${id}`, { method: 'DELETE' }),

  tokens: () => req<ApiToken[]>('/api/tokens'),
  createToken: (name: string) =>
    req<{ token: string; info: ApiToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteToken: (id: string) => req(`/api/tokens/${id}`, { method: 'DELETE' }),
};
