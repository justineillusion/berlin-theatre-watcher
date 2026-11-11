-- Face ID / empreinte (WebAuthn) : une clé PUBLIQUE par appareil (jamais d'image, jamais de biométrie).
CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT PRIMARY KEY,           -- identifiant de la passkey (base64url)
  chat_id      INTEGER NOT NULL,
  public_key   TEXT NOT NULL,              -- clé publique COSE (base64url)
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                       -- JSON ["internal","hybrid"]
  device       TEXT,                       -- « iPhone », « Mac »… (indicatif)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_chat ON passkeys (chat_id);
-- Défis à usage unique (5 min).
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  chat_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
