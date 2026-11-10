-- Notifications dans l'app (💌 envoyé, 🎟 réservé pour toi, demande d'ami, ami accepté) : la cloche 🔔.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,           -- destinataire
  kind       TEXT NOT NULL,              -- share | booked | friend_request | friend_ok
  from_id    INTEGER,
  item_id    TEXT,
  note       TEXT,
  at         TEXT,                       -- séance (🎟)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS notifications_chat ON notifications (chat_id, created_at);
-- « Proposer un lieu » / « Un retour » (Réglages) : lu par la propriétaire.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,              -- venue | feedback
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
