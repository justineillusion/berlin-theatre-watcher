-- Santé des scans (page /admin) : une ligne par lieu et par passage.
CREATE TABLE IF NOT EXISTS scan_reports (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run     TEXT NOT NULL,                   -- identifiant du passage (GitHub run, sinon horodatage)
  kind    TEXT NOT NULL,                   -- theatre | cinema
  venue   TEXT NOT NULL,
  found   INTEGER NOT NULL DEFAULT 0,      -- ce que la source a renvoyé
  kept    INTEGER NOT NULL DEFAULT 0,      -- ce qui est arrivé dans l'app
  dropped TEXT,                            -- JSON {raison: [titres…]}
  error   TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS scan_reports_kind_at ON scan_reports (kind, at);
