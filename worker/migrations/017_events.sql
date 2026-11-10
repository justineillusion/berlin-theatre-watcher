-- Tracking produit (docs/tracking.md) : un événement par action utile.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,                 -- NULL avant connexion
  name    TEXT NOT NULL,           -- open, want, book, seen, rate, review, share, link_out…
  item_id TEXT,
  target  TEXT,                    -- domaine du lien, nb de destinataires, lieu…
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_name_at ON events (name, at);
CREATE INDEX IF NOT EXISTS events_chat_at ON events (chat_id, at);
