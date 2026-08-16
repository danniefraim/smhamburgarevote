-- Rättelser under tävlingsdagen.
-- Designprinciper:
--  * Röster kan korrigeras i efterhand — raden bär spår av rättelsen och
--    submission_log/admin_log bär hela historiken.
--  * Avdrag kan vara procent ELLER fasta poäng (pct = 0 när avdraget är i poäng).
--  * Domarsammanslagningar sparar exakt vad de flyttade, så de kan ångras.

ALTER TABLE votes ADD COLUMN edited_at TEXT;
ALTER TABLE votes ADD COLUMN edited_by TEXT;
CREATE INDEX idx_votes_created ON votes(created_at);

ALTER TABLE avdrag ADD COLUMN points REAL NOT NULL DEFAULT 0;

CREATE TABLE judge_merges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES judges(id),
  to_id      INTEGER NOT NULL REFERENCES judges(id),
  detail     TEXT NOT NULL, -- JSON: { kortids: [...], aliasIds: [...] }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at  TEXT
);
