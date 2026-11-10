-- App web (hors Telegram) : connexion par le bot, puis session longue.
-- web_logins : demande de connexion en attente (nonce du lien t.me/<bot>?start=web_<nonce>),
--              chat_id rempli quand la personne confirme dans le bot ; 10 min max.
-- web_sessions : jeton de session (on ne garde que son SHA-256).
CREATE TABLE IF NOT EXISTS web_logins (
  nonce      TEXT PRIMARY KEY,
  chat_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS web_sessions_chat ON web_sessions (chat_id);
