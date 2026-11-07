import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type Category,
  type Expense,
  type ExpenseInput,
  type Summary,
  formatINR,
  monthRange,
  todayIST,
} from '../../src/shared/schema';
import { api, AuthError, type ApiToken } from './api';

type View = 'home' | 'settings';

export function App() {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [mcpUrl, setMcpUrl] = useState('');
  const [view, setView] = useState<View>('home');

  const check = useCallback(() => {
    api
      .session()
      .then((s) => (setMcpUrl(s.mcpUrl), setState('in')))
      .catch(() => setState('out'));
  }, []);
  useEffect(check, [check]);

  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof AuthError) setState('out');
    else throw e;
  }, []);

  if (state === 'loading') return <div className="splash" aria-busy="true" />;
  if (state === 'out') return <Login onDone={check} />;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setView('home')}>
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Rupee</span>
        </button>
        <button
          className="icon-btn"
          aria-label={view === 'home' ? 'Settings' : 'Back to expenses'}
          onClick={() => setView(view === 'home' ? 'settings' : 'home')}
        >
          {view === 'home' ? <GearIcon /> : <CloseIcon />}
        </button>
      </header>
      {view === 'home' ? (
        <Home onAuthError={onAuthError} />
      ) : (
        <Settings mcpUrl={mcpUrl} onAuthError={onAuthError} onLogout={() => setState('out')} />
      )}
    </div>
  );
}

// ---- Login -------------------------------------------------------------------

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>Rupee</h1>
        <p className="muted">Household expenses</p>
        <label htmlFor="pw">Household password</label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

// ---- Home --------------------------------------------------------------------

function shiftMonth(monthStart: string, delta: number): string {
  const [y, m] = monthStart.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

function monthLabel(monthStart: string) {
  return new Date(`${monthStart}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function Home({ onAuthError }: { onAuthError: (e: unknown) => void }) {
  const thisMonth = monthRange(todayIST()).from;
  const [month, setMonth] = useState(thisMonth);
  const [items, setItems] = useState<Expense[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [editing, setEditing] = useState<Expense | null>(null);
  const [toast, setToast] = useState('');
  const range = useMemo(() => monthRange(month), [month]);

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([api.list(range.from, range.to), api.summary(range.from, range.to)]);
      setItems(l.items);
      setSummary(s);
    } catch (e) {
      onAuthError(e);
    }
  }, [range, onAuthError]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  // Refresh when returning to the app (e.g. after logging something via an LLM).
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  async function add(input: ExpenseInput) {
    const e = await api.add(input);
    flash(`Added ${formatINR(e.amount)}`);
    if (e.date >= range.from && e.date <= range.to) await load();
  }

  const shown = items?.filter((e) => filter === 'all' || e.category === filter) ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, Expense[]>();
    for (const e of shown) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return [...m.entries()];
  }, [shown]);

  return (
    <main className="home">
      <section className="card">
        <h2 className="card-title">Add expense</h2>
        <ExpenseForm submitLabel="Add" onSubmit={add} onAuthError={onAuthError} />
      </section>

      <section className="card">
        <div className="month-nav">
          <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹
          </button>
          <h2>{monthLabel(month)}</h2>
          <button
            className="icon-btn"
            aria-label="Next month"
            disabled={month >= thisMonth}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        {summary ? <SummaryView s={summary} /> : <div className="skeleton" />}
      </section>

      <section className="card">
        <div className="list-head">
          <h2 className="card-title">Expenses</h2>
          <div className="chips" role="group" aria-label="Filter by category">
            {(['all', ...CATEGORIES] as const).map((c) => (
              <button
                key={c}
                className={`chip ${filter === c ? 'on' : ''} ${c !== 'all' ? `c-${c}` : ''}`}
                aria-pressed={filter === c}
                onClick={() => setFilter(c)}
              >
                {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        {items === null ? (
          <div className="skeleton" />
        ) : groups.length === 0 ? (
          <p className="empty">No expenses {filter !== 'all' ? `in ${CATEGORY_LABELS[filter]} ` : ''}this month yet.</p>
        ) : (
          groups.map(([date, list]) => (
            <div key={date} className="day">
              <div className="day-head">
                <span>{dayLabel(date)}</span>
                <span>{formatINR(list.reduce((s, e) => s + e.amount, 0))}</span>
              </div>
              <ul>
                {list.map((e) => (
                  <li key={e.id}>
                    <button className="row" onClick={() => setEditing(e)}>
                      <span className={`dot c-${e.category}`} aria-hidden />
                      <span className="desc">
                        {e.description}
                        <small>
                          {CATEGORY_LABELS[e.category]}
                          {e.source === 'mcp' && ' · via AI'}
                        </small>
                      </span>
                      <span className="amt">{formatINR(e.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {editing && (
        <EditDialog
          expense={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => (setEditing(null), flash(msg), load())}
          onAuthError={onAuthError}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}

function dayLabel(date: string) {
  const today = todayIST();
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (date === today) return 'Today';
  if (date === y.toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function SummaryView({ s }: { s: Summary }) {
  return (
    <div className="summary">
      <div className="total">
        <span className="muted">Total spent</span>
        <strong>{formatINR(s.total)}</strong>
      </div>
      <div className="bar" role="img" aria-label="Split by category">
        {s.total > 0 ? (
          CATEGORIES.map((c) =>
            s.byCategory[c].total > 0 ? (
              <span key={c} className={`c-${c}`} style={{ flexGrow: s.byCategory[c].total }} />
            ) : null,
          )
        ) : (
          <span className="none" />
        )}
      </div>
      <ul className="legend">
        {CATEGORIES.map((c) => (
          <li key={c}>
            <span className={`dot c-${c}`} aria-hidden />
            <span>{CATEGORY_LABELS[c]}</span>
            <span className="muted">{s.byCategory[c].percent}%</span>
            <strong>{formatINR(s.byCategory[c].total)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Expense form (add + edit) ----------------------------------------------

function ExpenseForm({
  initial,
  submitLabel,
  onSubmit,
  onAuthError,
}: {
  initial?: Expense;
  submitLabel: string;
  onSubmit: (input: ExpenseInput) => Promise<void>;
  onAuthError: (e: unknown) => void;
}) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState<Category | null>(initial?.category ?? null);
  const [date, setDate] = useState(initial?.date ?? todayIST());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!value || value <= 0) return setError('Enter an amount');
    if (!category) return setError('Pick a category');
    setBusy(true);
    setError('');
    try {
      await onSubmit({ amount: value, description: description.trim(), category, date });
      if (!initial) {
        setAmount('');
        setDescription('');
        setCategory(null);
        setDate(todayIST());
        amountRef.current?.focus();
      }
    } catch (err) {
      if (err instanceof AuthError) onAuthError(err);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="expense-form" onSubmit={submit}>
      <div className="amount-field">
        <span aria-hidden>₹</span>
        <input
          ref={amountRef}
          aria-label="Amount in rupees"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          required
        />
      </div>
      <input
        aria-label="Description"
        placeholder="What was it for?"
        value={description}
        maxLength={200}
        onChange={(e) => setDescription(e.target.value)}
        required
      />
      <div className="segmented" role="radiogroup" aria-label="Category">
        {CATEGORIES.map((c) => (
          <button
            type="button"
            key={c}
            role="radio"
            aria-checked={category === c}
            className={`c-${c} ${category === c ? 'on' : ''}`}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <div className="form-foot">
        <input type="date" aria-label="Date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function EditDialog({
  expense,
  onClose,
  onSaved,
  onAuthError,
}: {
  expense: Expense;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onAuthError: (e: unknown) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);

  async function remove() {
    if (!confirm(`Delete "${expense.description}" (${formatINR(expense.amount)})?`)) return;
    try {
      await api.remove(expense.id);
      onSaved('Deleted');
    } catch (e) {
      onAuthError(e);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog-head">
        <h2>Edit expense</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <ExpenseForm
        initial={expense}
        submitLabel="Save"
        onAuthError={onAuthError}
        onSubmit={async (input) => {
          await api.update(expense.id, input);
          onSaved('Saved');
        }}
      />
      <button className="danger" onClick={remove}>
        Delete expense
      </button>
    </dialog>
  );
}

// ---- Settings ----------------------------------------------------------------

function Settings({
  mcpUrl,
  onAuthError,
  onLogout,
}: {
  mcpUrl: string;
  onAuthError: (e: unknown) => void;
  onLogout: () => void;
}) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    api.tokens().then(setTokens).catch(onAuthError);
  }, [onAuthError]);
  useEffect(load, [load]);

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const { token } = await api.createToken(name.trim());
      setFresh(token);
      setName('');
      load();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function revoke(t: ApiToken) {
    if (!confirm(`Revoke "${t.name}"? Any app using it will stop working.`)) return;
    await api.deleteToken(t.id).catch(onAuthError);
    load();
  }

  return (
    <main className="home">
      <section className="card">
        <h2 className="card-title">Connect an AI assistant</h2>
        <p className="muted">
          Log expenses by chatting, e.g. <em>“spent ₹450 on dinner with friends”</em>. The assistant picks the
          category for you.
        </p>
        <label>MCP server URL</label>
        <div className="copy-row">
          <code>{mcpUrl}</code>
          <button onClick={() => copy(mcpUrl, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
        </div>
        <h3>Apps that sign in (Claude, ChatGPT and others)</h3>
        <p className="muted">
          Add a custom connector / MCP server with the URL above. A Rupee page opens — enter the household password
          and tap Allow.
        </p>
        <h3>Apps that take a token (Cursor, VS Code, Claude Code…)</h3>
        <p className="muted">
          Create a token below and configure the header <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Access tokens</h2>
        {fresh && (
          <div className="fresh">
            <p>Copy this token now — it won’t be shown again.</p>
            <div className="copy-row">
              <code>{fresh}</code>
              <button onClick={() => copy(fresh, 'token')}>{copied === 'token' ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
        <form className="token-form" onSubmit={create}>
          <input
            aria-label="Token name"
            placeholder="Name, e.g. My laptop – Cursor"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="primary">Create</button>
        </form>
        {tokens?.length ? (
          <ul className="tokens">
            {tokens.map((t) => (
              <li key={t.id}>
                <span>
                  {t.name}
                  <small>
                    {t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleDateString('en-IN')}` : 'Never used'}
                  </small>
                </span>
                <button className="link-danger" onClick={() => revoke(t)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : (
          tokens && <p className="empty">No tokens yet.</p>
        )}
      </section>

      <button className="danger" onClick={() => api.logout().finally(onLogout)}>
        Sign out of this device
      </button>
    </main>
  );
}

// ---- Icons -------------------------------------------------------------------

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
