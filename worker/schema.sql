-- Berlin Theatre Watcher — base D1 du bot multi-utilisateurs.
-- Appliquer : npx wrangler d1 execute theatre-bot --remote --file=schema.sql
-- (idempotent : CREATE ... IF NOT EXISTS)
-- Base créée avant une colonne ajoutée ici : voir migrations/ (ALTER TABLE, une seule fois).

-- Une personne inscrite au bot (chat privé : chat_id == user id Telegram).
CREATE TABLE IF NOT EXISTS users (
  chat_id      INTEGER PRIMARY KEY,
  first_name   TEXT NOT NULL,
  username     TEXT,
  active       INTEGER NOT NULL DEFAULT 1,   -- 0 = a bloqué le bot / s'est désinscrit
  pending_item TEXT,                         -- item en attente d'un « petit mot » après une note
  lang         TEXT NOT NULL DEFAULT 'fr',   -- langue des messages : fr | en (/langue)
  invite_code  TEXT,                         -- lien d'invitation personnel (migrations/006)
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  bot_seen_at TEXT,                          -- dernier message / clic dans le bot
  app_seen_at TEXT                           -- dernière ouverture de la mini-app
);

-- Lieux : théâtres + expos (config.yaml, scan) et cinémas (cinema.yaml, job ciné).
CREATE TABLE IF NOT EXISTS venues (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'theatre',  -- theatre | expo | cinema
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
  text_en    TEXT,                           -- variantes anglaises (rendues si un ami lit en anglais)
  line_en    TEXT,
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  sold TEXT                      -- dates complètes (JSON), grisées dans la mini-app
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
  booked_at  TEXT,                           -- 🎟 date choisie (migrations/003)
  booked_on  TEXT,
  followup_sent INTEGER NOT NULL DEFAULT 0,
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

-- Lot du matin : les fiches nouvelles / nouvelles dates / dernières semaines attendent ici
-- l'envoi groupé de ~9:00 (Berlin), au plus un message par jour et par personne.
CREATE TABLE IF NOT EXISTS daily_queue (
  chat_id    INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- new | new_dates | last_weeks
  header     TEXT,                          -- en-tête de la fiche (« 🆕 Nouvelles dates… »)
  queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT,                          -- NULL = pas encore dans un lot
  PRIMARY KEY (chat_id, item_id)
);

-- Récap du dimanche (9:00 Berlin) : les fiches films du ciné de la semaine attendent ici,
-- pour partir juste après le message d'en-tête du récap (un en-tête, puis les fiches).
CREATE TABLE IF NOT EXISTS film_queue (
  chat_id    INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- new | new_dates
  header     TEXT,
  dates      TEXT NOT NULL DEFAULT '[]',
  text       TEXT NOT NULL,
  markup     TEXT,
  queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT,
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
-- Invitations à laisser un avis (force_reply) : plusieurs ouvertes à la fois,
-- une réponse est rattachée à SON item via reply_to_message.message_id.
CREATE TABLE IF NOT EXISTS review_prompts (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  closed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL DEFAULT 'review',   -- review | date (migrations/003)
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS review_prompts_open ON review_prompts (chat_id, closed, created_at);

-- Connexions entre personnes (migrations/006) : une paire = une ligne (a < b).
CREATE TABLE IF NOT EXISTS connections (
  a            INTEGER NOT NULL,
  b            INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending (demande de requested_by) | ok
  requested_by INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a, b)
);
