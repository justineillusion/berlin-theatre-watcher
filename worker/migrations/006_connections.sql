-- Connexions entre personnes (novembre 2026) : chacun ne voit les ⭐ 🎟 ✅ que de ses connexions.
-- Une paire = une ligne (a < b). status : pending (demande de requested_by) | ok.
-- Une seule fois :  npx wrangler d1 execute theatre-bot --remote --file=migrations/006_connections.sql
CREATE TABLE IF NOT EXISTS connections (
  a            INTEGER NOT NULL,
  b            INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a, b)
);
-- Les membres d'avant se connaissent déjà tous (une seule bande) : connectés d'office.
INSERT OR IGNORE INTO connections (a, b, status)
  SELECT u1.chat_id, u2.chat_id, 'ok' FROM users u1, users u2 WHERE u1.chat_id < u2.chat_id;
-- Lien d'invitation personnel : s'inscrire avec, c'est être connecté à la personne.
ALTER TABLE users ADD COLUMN invite_code TEXT;
