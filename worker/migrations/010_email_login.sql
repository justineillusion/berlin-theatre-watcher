-- Connexion par email (app web) : chacun lie son adresse une fois (Réglages), puis reçoit
-- un code à 6 chiffres + un lien. On ne garde que les SHA-256 du code et du lien ; 15 min, 5 essais.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS email_logins (
  id         TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  code_hash  TEXT NOT NULL,
  link_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
