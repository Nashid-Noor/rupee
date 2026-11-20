-- Remove 'pf' as an income type. PF contributions are already deducted from
-- in-hand salary and PF interest stays in the PF account, so neither is household
-- income. Existing 'pf' rows become 'other' with a "PF:" description prefix.
-- SQLite can't change a CHECK constraint, so rebuild the incomes table.
CREATE TABLE incomes_new (
  id           TEXT PRIMARY KEY,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  type         TEXT    NOT NULL CHECK (type IN ('salary', 'bonus', 'dividend', 'equity', 'interest', 'rent', 'other')),
  description  TEXT    NOT NULL DEFAULT '',
  received_on  TEXT    NOT NULL,              -- YYYY-MM-DD (India time)
  source       TEXT    NOT NULL CHECK (source IN ('web', 'mcp')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT
);
INSERT INTO incomes_new (id, amount_paise, type, description, received_on, source, created_at, updated_at)
  SELECT id,
         amount_paise,
         CASE WHEN type = 'pf' THEN 'other' ELSE type END,
         CASE WHEN type = 'pf' THEN TRIM('PF: ' || description) ELSE description END,
         received_on, source, created_at, updated_at
  FROM incomes;
DROP TABLE incomes;
ALTER TABLE incomes_new RENAME TO incomes;
CREATE INDEX idx_incomes_received_on ON incomes (received_on DESC, created_at DESC);
