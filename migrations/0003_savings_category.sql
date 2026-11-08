-- Add 'savings' as an expense category. SQLite can't change a CHECK constraint,
-- so rebuild the expenses table. Tags are copied aside first and expense_tags is
-- dropped before expenses, so the ON DELETE CASCADE never fires.
CREATE TABLE tags_backup AS SELECT expense_id, tag FROM expense_tags;
DROP TABLE expense_tags;

CREATE TABLE expenses_new (
  id           TEXT PRIMARY KEY,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  description  TEXT    NOT NULL,
  category     TEXT    NOT NULL CHECK (category IN ('needs', 'wants', 'investment', 'savings')),
  spent_on     TEXT    NOT NULL,              -- YYYY-MM-DD (India time)
  source       TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT
);
INSERT INTO expenses_new (id, amount_paise, description, category, spent_on, source, created_at, updated_at)
  SELECT id, amount_paise, description, category, spent_on, source, created_at, updated_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_spent_on ON expenses (spent_on DESC, created_at DESC);

CREATE TABLE expense_tags (
  expense_id TEXT NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (expense_id, tag)
);
INSERT INTO expense_tags (expense_id, tag) SELECT expense_id, tag FROM tags_backup;
DROP TABLE tags_backup;
CREATE INDEX idx_expense_tags_tag ON expense_tags (tag);
