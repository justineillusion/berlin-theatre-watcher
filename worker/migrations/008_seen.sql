-- Activité, pour /membres : dernier message/clic dans le bot, dernière ouverture de la mini-app.
ALTER TABLE users ADD COLUMN bot_seen_at TEXT;
ALTER TABLE users ADD COLUMN app_seen_at TEXT;
