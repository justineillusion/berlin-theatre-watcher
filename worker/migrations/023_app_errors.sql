-- Surveillance (src/monitor.ts) : erreurs serveur (5xx, 4xx inattendus), requêtes lentes, erreurs et lenteurs vues
-- par les téléphones (JavaScript, réseau, chargement). Alerte Telegram à la propriétaire, historique dans l'admin.
CREATE TABLE IF NOT EXISTS app_errors (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  src      TEXT NOT NULL,              -- server | client
  kind     TEXT NOT NULL,              -- 5xx | 4xx | slow_api | js | network | slow_load
  path     TEXT,
  status   INTEGER,
  ms       INTEGER,
  msg      TEXT,
  who      TEXT,                       -- @pseudo si connu
  ua       TEXT,
  alerted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS app_errors_at ON app_errors (at);
CREATE INDEX IF NOT EXISTS app_errors_alerted ON app_errors (alerted, at);
