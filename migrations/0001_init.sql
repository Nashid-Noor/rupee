-- Expenses: one shared household ledger.
CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  description  TEXT    NOT NULL,
  category     TEXT    NOT NULL CHECK (category IN ('needs', 'wants', 'investment')),
  spent_on     TEXT    NOT NULL,              -- YYYY-MM-DD (India time)
  source       TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT
);

CREATE INDEX idx_expenses_spent_on ON expenses (spent_on DESC, created_at DESC);

-- Personal access tokens for LLM clients that take a URL + bearer header.
-- Only the SHA-256 hash of each token is stored.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);
