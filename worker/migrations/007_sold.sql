-- Dates complètes (surtitrées EN) d'une pièce : JSON ["AAAA-MM-JJ HH:MM", ...].
-- La mini-app les grise « Complet » ; les annonces n'utilisent que items.dates (places libres).
ALTER TABLE items ADD COLUMN sold TEXT;
