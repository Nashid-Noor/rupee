-- Income entries (salary is entered in-hand, after tax/PF deductions).
CREATE TABLE incomes (
  id           TEXT PRIMARY KEY,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  type         TEXT    NOT NULL CHECK (type IN ('salary', 'bonus', 'dividend', 'equity', 'pf', 'interest', 'rent', 'other')),
  description  TEXT    NOT NULL DEFAULT '',
  received_on  TEXT    NOT NULL,              -- YYYY-MM-DD (India time)
  source       TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT
);

CREATE INDEX idx_incomes_received_on ON incomes (received_on DESC, created_at DESC);

-- Tags on expenses (lowercase, hyphenated, e.g. "food-delivery").
CREATE TABLE expense_tags (
  expense_id TEXT NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (expense_id, tag)
);

CREATE INDEX idx_expense_tags_tag ON expense_tags (tag);

-- Key/value app settings (e.g. budget caps as JSON).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
