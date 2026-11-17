-- « Proposer une sortie » : une fiche, des amis, 1 à 3 créneaux. Chacun répond, tout le monde voit les réponses ;
-- « C'est calé » → 🎟 réservé pour tous ceux qui ont dit oui à ce créneau. Lien public /app?p=<id> (sans compte).
CREATE TABLE IF NOT EXISTS proposals (
  id         TEXT PRIMARY KEY,              -- 24 hex, sert aussi de lien
  item_id    TEXT NOT NULL,
  from_id    INTEGER NOT NULL,              -- qui propose
  note       TEXT,
  slots      TEXT NOT NULL,                 -- JSON ["2026-11-21", "2026-12-17 19:00"]
  chosen     TEXT,                          -- le créneau calé
  status     TEXT NOT NULL DEFAULT 'open',  -- open | set | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Participants : comptes (pid « u<chat_id> ») ou personnes venues par le lien sans compte (pid « g<empreinte> »).
CREATE TABLE IF NOT EXISTS proposal_people (
  proposal_id TEXT NOT NULL,
  pid         TEXT NOT NULL,
  chat_id     INTEGER,
  name        TEXT NOT NULL,
  answers     TEXT,                         -- JSON {"2026-11-21": 1, "2026-11-22": 0} ; NULL = pas encore répondu
  note        TEXT,
  answered_at TEXT,
  PRIMARY KEY (proposal_id, pid)
);
CREATE INDEX IF NOT EXISTS proposal_people_chat ON proposal_people (chat_id);
-- Groupes d'amis : raccourcis PRIVÉS (seul·e la propriétaire les voit ; les invités ne voient jamais le nom).
CREATE TABLE IF NOT EXISTS friend_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      INTEGER NOT NULL,
  name       TEXT NOT NULL,
  members    TEXT NOT NULL,                 -- JSON [chat_id, …]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS friend_groups_owner ON friend_groups (owner);
-- Notification liée à une proposition : son id.
ALTER TABLE notifications ADD COLUMN ref TEXT;
