-- Lieux « à la carte » (opéras, Philharmonie) : proposés dans Réglages, jamais d'abonnement d'office.
ALTER TABLE venues ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;
