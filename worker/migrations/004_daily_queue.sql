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
