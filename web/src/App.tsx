import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  APP_NAME,
  CATEGORIES,
  CATEGORY_LABELS,
  isTarget,
  INCOME_TYPES,
  INCOME_TYPE_LABELS,
  type Caps,
  type Category,
  type Expense,
  type ExpenseInput,
  type Income,
  type IncomeInput,
  type IncomeType,
  type Summary,
  type TagTotal,
  formatINR,
  monthRange,
  normalizeTag,
  shiftMonth,
  todayIST,
} from '../../src/shared/schema';
import { api, AuthError, type ApiToken } from './api';

type View = 'home' | 'settings';
type OnAuthError = (e: unknown) => void;

export function App() {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [mcpUrl, setMcpUrl] = useState('');
  const [view, setView] = useState<View>('home');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

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
          <span>{APP_NAME}</span>
        </button>
        <button
          className="icon-btn"
          aria-label={view === 'home' ? 'Settings' : 'Back'}
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
        <h1>{APP_NAME}</h1>
        <p className="muted">Household money</p>
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

function monthLabel(monthStart: string) {
  return new Date(`${monthStart}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function dayLabel(date: string) {
  const today = todayIST();
  if (date === today) return 'Today';
  if (date === shiftDay(today, -1)) return 'Yesterday';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function shiftDay(date: string, delta: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function groupByDate<T extends { date: string }>(items: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const e of items) m.set(e.date, [...(m.get(e.date) ?? []), e]);
  return [...m.entries()];
}

type Editing = { kind: 'expense'; item: Expense } | { kind: 'income'; item: Income } | null;

function Home({ onAuthError }: { onAuthError: OnAuthError }) {
  const thisMonth = monthRange(todayIST()).from;
  const [month, setMonth] = useState(thisMonth);
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [incomes, setIncomes] = useState<Income[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [topTags, setTopTags] = useState<TagTotal[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [mode, setMode] = useState<'expense' | 'income'>('expense');
  const [tab, setTab] = useState<'expenses' | 'income'>('expenses');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [toast, setToast] = useState('');
  const range = useMemo(() => monthRange(month), [month]);

  const load = useCallback(async () => {
    try {
      const [e, i, s, t, all] = await Promise.all([
        api.list(range.from, range.to),
        api.incomes(range.from, range.to),
        api.summary(range.from, range.to),
        api.tagBreakdown(range.from, range.to),
        api.tags(),
      ]);
      setExpenses(e.items);
      setIncomes(i.items);
      setSummary(s);
      setTopTags(t);
      setAllTags(all.map((x) => x.tag));
    } catch (err) {
      onAuthError(err);
    }
  }, [range, onAuthError]);

  useEffect(() => {
    setExpenses(null);
    setIncomes(null);
    setSummary(null);
    load();
  }, [load]);

  // Refresh when returning to the app (e.g. after logging something via an AI assistant).
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function flash(msg: string) {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }

  async function addExpense(input: ExpenseInput) {
    const e = await api.add(input);
    flash(`Added ${formatINR(e.amount)} expense`);
    if (e.date >= range.from && e.date <= range.to) await load();
  }

  async function addIncome(input: IncomeInput) {
    const i = await api.addIncome(input);
    flash(`Added ${formatINR(i.amount)} income`);
    if (i.date >= range.from && i.date <= range.to) await load();
  }

  function pickTag(tag: string) {
    setTab('expenses');
    setTagFilter(tag === tagFilter ? null : tag);
    document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const shownExpenses =
    expenses?.filter((e) => (filter === 'all' || e.category === filter) && (!tagFilter || e.tags.includes(tagFilter))) ?? [];
  const expenseGroups = useMemo(() => groupByDate(shownExpenses), [shownExpenses]);
  const incomeGroups = useMemo(() => groupByDate(incomes ?? []), [incomes]);

  return (
    <main className="home">
      <section className="card">
        <div className="mode-switch" role="tablist" aria-label="Entry type">
          <button role="tab" aria-selected={mode === 'expense'} className={mode === 'expense' ? 'on' : ''} onClick={() => setMode('expense')}>
            Expense
          </button>
          <button role="tab" aria-selected={mode === 'income'} className={mode === 'income' ? 'on' : ''} onClick={() => setMode('income')}>
            Income
          </button>
        </div>
        {mode === 'expense' ? (
          <ExpenseForm key="e" submitLabel="Add" allTags={allTags} onSubmit={addExpense} onAuthError={onAuthError} />
        ) : (
          <IncomeForm key="i" submitLabel="Add" onSubmit={addIncome} onAuthError={onAuthError} />
        )}
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

      {topTags.length > 0 && (
        <section className="card">
          <h2 className="card-title">Top tags</h2>
          <div className="tag-cloud">
            {topTags.map((t) => (
              <button key={t.tag} className={`tag-total ${tagFilter === t.tag ? 'on' : ''}`} onClick={() => pickTag(t.tag)}>
                <span>#{t.tag}</span>
                <strong>{formatINR(t.total)}</strong>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card" id="activity">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'expenses'} className={tab === 'expenses' ? 'on' : ''} onClick={() => setTab('expenses')}>
            Expenses
          </button>
          <button role="tab" aria-selected={tab === 'income'} className={tab === 'income' ? 'on' : ''} onClick={() => setTab('income')}>
            Income
          </button>
        </div>

        {tab === 'expenses' ? (
          <>
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
              {tagFilter && (
                <button className="chip on tag-chip" onClick={() => setTagFilter(null)} aria-label={`Remove filter #${tagFilter}`}>
                  #{tagFilter} ✕
                </button>
              )}
            </div>
            {expenses === null ? (
              <div className="skeleton" />
            ) : expenseGroups.length === 0 ? (
              <p className="empty">No matching expenses this month.</p>
            ) : (
              expenseGroups.map(([date, list]) => (
                <div key={date} className="day">
                  <div className="day-head">
                    <span>{dayLabel(date)}</span>
                    <span>{formatINR(list.reduce((s, e) => s + e.amount, 0))}</span>
                  </div>
                  <ul>
                    {list.map((e) => (
                      <li key={e.id}>
                        <button className="row" onClick={() => setEditing({ kind: 'expense', item: e })}>
                          <span className={`dot c-${e.category}`} aria-hidden />
                          <span className="desc">
                            {e.description}
                            <small>
                              {CATEGORY_LABELS[e.category]}
                              {e.source === 'mcp' && ' · via AI'}
                              {e.tags.length > 0 && <span className="row-tags"> · {e.tags.map((t) => `#${t}`).join(' ')}</span>}
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
          </>
        ) : incomes === null ? (
          <div className="skeleton" />
        ) : incomeGroups.length === 0 ? (
          <p className="empty">No income recorded this month.</p>
        ) : (
          incomeGroups.map(([date, list]) => (
            <div key={date} className="day">
              <div className="day-head">
                <span>{dayLabel(date)}</span>
                <span>{formatINR(list.reduce((s, i) => s + i.amount, 0))}</span>
              </div>
              <ul>
                {list.map((i) => (
                  <li key={i.id}>
                    <button className="row" onClick={() => setEditing({ kind: 'income', item: i })}>
                      <span className="dot income" aria-hidden />
                      <span className="desc">
                        {i.description || INCOME_TYPE_LABELS[i.type]}
                        <small>
                          {INCOME_TYPE_LABELS[i.type]}
                          {i.source === 'mcp' && ' · via AI'}
                        </small>
                      </span>
                      <span className="amt income-amt">+{formatINR(i.amount)}</span>
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
          editing={editing}
          allTags={allTags}
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

// ---- Summary -------------------------------------------------------------------

function SummaryView({ s }: { s: Summary }) {
  const incomeTypes = Object.entries(s.income.byType) as [IncomeType, number][];
  return (
    <div className="summary">
      <div className="stats">
        <div>
          <span className="muted">Income</span>
          <strong className="income-amt">{formatINR(s.income.total)}</strong>
        </div>
        <div>
          <span className="muted">Spent</span>
          <strong>{formatINR(s.total)}</strong>
        </div>
        <div>
          <span className="muted">Left over</span>
          <strong className={s.saved < 0 ? 'neg' : ''}>{formatINR(s.saved)}</strong>
        </div>
      </div>

      {incomeTypes.length > 0 && (
        <p className="income-split">
          {incomeTypes.map(([t, v]) => `${INCOME_TYPE_LABELS[t]} ${formatINR(v)}`).join(' · ')}
        </p>
      )}

      {s.budget ? (
        <>
          <div className="budget-head">
            <span>
              Caps on in-hand salary <strong>{formatINR(s.budget.salary)}</strong>
            </span>
            {s.budget.estimated && <span className="badge">Estimated from last month</span>}
          </div>
          <ul className="budget">
            {CATEGORIES.map((c) => {
              const b = s.budget!.byCategory[c];
              const target = isTarget(c);
              const note = {
                ok: `${formatINR(Math.max(b.limit - b.spent, 0))} left`,
                near: `${formatINR(Math.max(b.limit - b.spent, 0))} left`,
                over: `${formatINR(b.spent - b.limit)} over`,
                below: `${formatINR(Math.max(b.limit - b.spent, 0))} to go`,
                met: 'Target reached',
              }[b.status];
              return (
                <li key={c} className={`c-${c} st-${b.status}`}>
                  <div className="budget-row">
                    <span className="budget-name">
                      <span className={`dot c-${c}`} aria-hidden />
                      {CATEGORY_LABELS[c]}
                      <small>
                        {b.percent}% {target ? 'target' : 'cap'}
                      </small>
                    </span>
                    <span className="budget-nums">
                      <strong>{formatINR(b.spent)}</strong> / {formatINR(b.limit)}
                    </span>
                  </div>
                  <div className="meter" role="meter" aria-valuenow={b.used} aria-valuemin={0} aria-valuemax={100} aria-label={`${CATEGORY_LABELS[c]} ${b.used}% of ${target ? 'target' : 'cap'}`}>
                    <span style={{ width: `${Math.min(b.used, 100)}%` }} />
                  </div>
                  <div className="budget-note">
                    <span>{b.used}%</span>
                    <span>{note}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <div className="bar" role="img" aria-label="Spending split by category">
            {s.total > 0 ? (
              CATEGORIES.map((c) =>
                s.byCategory[c].total > 0 ? <span key={c} className={`c-${c}`} style={{ flexGrow: s.byCategory[c].total }} /> : null,
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
          <p className="hint">Add this month’s salary (as Income) to see your caps.</p>
        </>
      )}
    </div>
  );
}

// ---- Forms ---------------------------------------------------------------------

function AmountField({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <div className="amount-field">
      <span aria-hidden>₹</span>
      <input
        ref={inputRef}
        aria-label="Amount in rupees"
        inputMode="decimal"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        required
      />
    </div>
  );
}

function TagInput({
  tags,
  setTags,
  draft,
  setDraft,
  allTags,
}: {
  tags: string[];
  setTags: (t: string[]) => void;
  draft: string;
  setDraft: (d: string) => void;
  allTags: string[];
}) {
  function commit(raw: string) {
    const t = normalizeTag(raw);
    if (t && !tags.includes(t) && tags.length < 10) setTags([...tags, t]);
    setDraft('');
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      setTags(tags.slice(0, -1));
    }
  }
  const suggestions = useMemo(() => {
    const d = normalizeTag(draft);
    return allTags.filter((t) => !tags.includes(t) && (!d || t.includes(d))).slice(0, 6);
  }, [allTags, tags, draft]);

  return (
    <div className="tag-input">
      <div className="tag-box">
        {tags.map((t) => (
          <button type="button" key={t} className="tag" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
            #{t} <span aria-hidden>✕</span>
          </button>
        ))}
        <input
          aria-label="Tags"
          placeholder={tags.length ? '' : 'Tags (optional) — e.g. groceries, swiggy'}
          value={draft}
          onChange={(e) => (e.target.value.endsWith(',') ? commit(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
          onKeyDown={onKey}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="tag-suggest" aria-label="Suggested tags">
          {suggestions.map((t) => (
            <button type="button" key={t} onMouseDown={(e) => e.preventDefault()} onClick={() => commit(t)}>
              + {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpenseForm({
  initial,
  submitLabel,
  allTags,
  onSubmit,
  onAuthError,
}: {
  initial?: Expense;
  submitLabel: string;
  allTags: string[];
  onSubmit: (input: ExpenseInput) => Promise<void>;
  onAuthError: OnAuthError;
}) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState<Category | null>(initial?.category ?? null);
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [draft, setDraft] = useState('');
  const [date, setDate] = useState(initial?.date ?? todayIST());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!value || value <= 0) return setError('Enter an amount');
    if (!category) return setError('Pick a category');
    const pending = normalizeTag(draft);
    const allTagsNow = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ amount: value, description: description.trim(), category, date, tags: allTagsNow });
      if (!initial) {
        setAmount('');
        setDescription('');
        setCategory(null);
        setTags([]);
        setDraft('');
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
    <form className="entry-form" onSubmit={submit}>
      <AmountField value={amount} onChange={setAmount} inputRef={amountRef} />
      <input
        aria-label="Description"
        placeholder="What was it for?"
        value={description}
        maxLength={200}
        onChange={(e) => setDescription(e.target.value)}
        required
      />
      <div className="segmented cats" role="radiogroup" aria-label="Category">
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
      <TagInput tags={tags} setTags={setTags} draft={draft} setDraft={setDraft} allTags={allTags} />
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

function IncomeForm({
  initial,
  submitLabel,
  onSubmit,
  onAuthError,
}: {
  initial?: Income;
  submitLabel: string;
  onSubmit: (input: IncomeInput) => Promise<void>;
  onAuthError: OnAuthError;
}) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [type, setType] = useState<IncomeType | null>(initial?.type ?? null);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [date, setDate] = useState(initial?.date ?? todayIST());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!value || value <= 0) return setError('Enter an amount');
    if (!type) return setError('Pick an income type');
    setBusy(true);
    setError('');
    try {
      await onSubmit({ amount: value, type, description: description.trim(), date });
      if (!initial) {
        setAmount('');
        setType(null);
        setDescription('');
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
    <form className="entry-form" onSubmit={submit}>
      <AmountField value={amount} onChange={setAmount} inputRef={amountRef} />
      <div className="type-grid" role="radiogroup" aria-label="Income type">
        {INCOME_TYPES.map((t) => (
          <button type="button" key={t} role="radio" aria-checked={type === t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
            {INCOME_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      {type === 'salary' && <p className="hint">Enter the in-hand amount credited to your bank.</p>}
      <input
        aria-label="Description"
        placeholder="Note (optional) — e.g. HDFC dividend"
        value={description}
        maxLength={200}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="form-foot">
        <input type="date" aria-label="Date received" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function EditDialog({
  editing,
  allTags,
  onClose,
  onSaved,
  onAuthError,
}: {
  editing: NonNullable<Editing>;
  allTags: string[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onAuthError: OnAuthError;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  const { kind, item } = editing;
  const label = kind === 'expense' ? (item as Expense).description : (item as Income).description || INCOME_TYPE_LABELS[(item as Income).type];

  async function remove() {
    if (!confirm(`Delete "${label}" (${formatINR(item.amount)})?`)) return;
    try {
      await (kind === 'expense' ? api.remove(item.id) : api.removeIncome(item.id));
      onSaved('Deleted');
    } catch (e) {
      onAuthError(e);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog-head">
        <h2>Edit {kind}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {kind === 'expense' ? (
        <ExpenseForm
          initial={item as Expense}
          submitLabel="Save"
          allTags={allTags}
          onAuthError={onAuthError}
          onSubmit={async (input) => {
            await api.update(item.id, input);
            onSaved('Saved');
          }}
        />
      ) : (
        <IncomeForm
          initial={item as Income}
          submitLabel="Save"
          onAuthError={onAuthError}
          onSubmit={async (input) => {
            await api.updateIncome(item.id, input);
            onSaved('Saved');
          }}
        />
      )}
      <button className="danger" onClick={remove}>
        Delete {kind}
      </button>
    </dialog>
  );
}

// ---- Settings ------------------------------------------------------------------

function CapsSettings({ onAuthError }: { onAuthError: OnAuthError }) {
  const [caps, setCaps] = useState<Record<Category, string> | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .caps()
      .then((c) => setCaps({ needs: String(c.needs), wants: String(c.wants), investment: String(c.investment), savings: String(c.savings) }))
      .catch(onAuthError);
  }, [onAuthError]);

  if (!caps) return <div className="skeleton" />;
  const nums = CATEGORIES.map((c) => Number(caps[c]) || 0);
  const sum = nums.reduce((a, b) => a + b, 0);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMsg('');
    try {
      const [needs, wants, investment, savings] = nums;
      await api.setCaps({ needs, wants, investment, savings } satisfies Caps);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (err) {
      if (err instanceof AuthError) onAuthError(err);
      else setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={save}>
      <p className="muted">
        Percent of each month’s <strong>in-hand salary</strong>. Needs and Wants are caps to stay under; Investment and Savings are
        targets to reach. You’ll be warned, never blocked.
      </p>
      <div className="caps-grid">
        {CATEGORIES.map((c) => (
          <label key={c} className={`cap-field c-${c}`}>
            <span>
              <span className={`dot c-${c}`} aria-hidden /> {CATEGORY_LABELS[c]} <small>{isTarget(c) ? 'target' : 'cap'}</small>
            </span>
            <div className="pct">
              <input
                inputMode="decimal"
                value={caps[c]}
                onChange={(e) => setCaps({ ...caps, [c]: e.target.value.replace(/[^\d.]/g, '') })}
                aria-label={`${CATEGORY_LABELS[c]} percent`}
              />
              <span>%</span>
            </div>
          </label>
        ))}
      </div>
      <div className="caps-foot">
        <span className={sum > 100 ? 'error' : 'muted'}>
          Total {sum}%{sum < 100 ? ` · ${100 - sum}% unplanned` : sum > 100 ? ' — must be 100 or less' : ''}
        </span>
        <button className="primary" disabled={sum > 100}>
          {msg || 'Save'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Settings({ mcpUrl, onAuthError, onLogout }: { mcpUrl: string; onAuthError: OnAuthError; onLogout: () => void }) {
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
        <h2 className="card-title">Spending caps</h2>
        <CapsSettings onAuthError={onAuthError} />
      </section>

      <section className="card">
        <h2 className="card-title">Connect an AI assistant</h2>
        <p className="muted">
          Log money by chatting, e.g. <em>“spent ₹450 on dinner with friends”</em> or <em>“salary of ₹1.2L came in”</em>. The
          assistant picks the category and tags for you.
        </p>
        <label>MCP server URL</label>
        <div className="copy-row">
          <code>{mcpUrl}</code>
          <button onClick={() => copy(mcpUrl, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
        </div>
        <h3>Apps that sign in (Claude, ChatGPT and others)</h3>
        <p className="muted">
          Add a custom connector / MCP server with the URL above. A {APP_NAME} page opens — enter the household password and tap
          Allow.
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
                  <small>{t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleDateString('en-IN')}` : 'Never used'}</small>
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

// ---- Icons ---------------------------------------------------------------------

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
