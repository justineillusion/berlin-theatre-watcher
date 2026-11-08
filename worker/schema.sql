-- Berlin Theatre Watcher — base D1 du bot multi-utilisateurs.
-- Appliquer : npx wrangler d1 execute theatre-bot --remote --file=schema.sql
-- (idempotent : CREATE ... IF NOT EXISTS)

-- Une personne inscrite au bot (chat privé : chat_id == user id Telegram).
CREATE TABLE IF NOT EXISTS users (
  chat_id      INTEGER PRIMARY KEY,
  first_name   TEXT NOT NULL,
  username     TEXT,
  active       INTEGER NOT NULL DEFAULT 1,   -- 0 = a bloqué le bot / s'est désinscrit
  pending_item TEXT,                         -- item en attente d'un « petit mot » après une note
  joined_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lieux (théâtres + expos), poussés par le scraper depuis config.yaml.
CREATE TABLE IF NOT EXISTS venues (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'theatre',  -- theatre | expo
  position INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1        -- 0 = retiré de config.yaml
);

-- Qui suit quel lieu. primed=0 : abonnement neuf, le prochain scan enregistre
-- le catalogue en silence (sinon : 40 notifs d'un coup à l'inscription).
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id  INTEGER NOT NULL,
  venue_id TEXT NOT NULL,
  primed   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, venue_id)
);

-- Une pièce (toutes ses dates) ou une expo. id = sha1(lieu|titre)[:12], stable
-- d'une saison à l'autre : « Vu » / « Ignorer » survivent aux reprises.
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  venue_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT,
  dates      TEXT NOT NULL DEFAULT '[]',     -- JSON ["2026-11-18 20:00", …] (théâtre)
  start_date TEXT,                           -- expos
  end_date   TEXT,                           -- expos
  starred    INTEGER NOT NULL DEFAULT 0,     -- matche keywords_love
  text       TEXT,                           -- corps du message (HTML Telegram)
  line       TEXT,                           -- bloc pour les récaps
  last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Réaction d'une personne à une pièce/expo.
CREATE TABLE IF NOT EXISTS reactions (
  chat_id    INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  interested INTEGER NOT NULL DEFAULT 0,
  status     TEXT,                           -- NULL | 'seen' | 'ignored'
  rating     INTEGER,                        -- 1..5 (après « Vu »)
  comment    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, item_id)
);

-- Ce qui a été envoyé à qui : dates déjà annoncées (pour ne réalerter que sur
-- des dates inédites) + le message, pour le mettre à jour quand un ami clique ⭐.
CREATE TABLE IF NOT EXISTS deliveries (
  chat_id      INTEGER NOT NULL,
  item_id      TEXT NOT NULL,
  dates        TEXT NOT NULL DEFAULT '[]',
  message_id   INTEGER,                      -- NULL = enregistré en silence (amorçage)
  header       TEXT,                         -- « 🆕 Nouvelles dates… » au moment de l'envoi
  reminded     INTEGER NOT NULL DEFAULT 0,   -- rappel « dernières semaines » envoyé
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, item_id)
);

-- Réglages : invite_code, group_chat_id.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reactions_item ON reactions(item_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_item ON deliveries(item_id);
CREATE INDEX IF NOT EXISTS idx_items_venue ON items(venue_id);
