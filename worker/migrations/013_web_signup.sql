-- Inscription sur le web (sans Telegram) : la personne est créée en attente (active = 0, pending = 1)
-- jusqu'au code reçu par email ; invited_by = qui a partagé le lien (connectés à la validation).
ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invited_by INTEGER;
