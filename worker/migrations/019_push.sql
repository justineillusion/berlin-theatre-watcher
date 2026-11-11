-- Web Push : un abonnement par appareil (adresse d'envoi du navigateur + ses clés publiques).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  device     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT
);
CREATE INDEX IF NOT EXISTS push_subs_chat ON push_subs (chat_id);
