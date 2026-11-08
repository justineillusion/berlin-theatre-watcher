-- Langue par personne + variantes anglaises des textes (novembre 2026).
-- Une seule fois sur une base créée avant : SQLite n'a pas de ADD COLUMN IF NOT EXISTS
-- (relancer donne « duplicate column name », sans dégât).
--   npx wrangler d1 execute theatre-bot --remote --file=migrations/001_lang.sql
ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr';
ALTER TABLE items ADD COLUMN text_en TEXT;
ALTER TABLE items ADD COLUMN line_en TEXT;
