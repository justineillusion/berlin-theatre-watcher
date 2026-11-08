-- Récap du dimanche (9:00 Berlin) : les fiches films du ciné de la semaine attendent ici,
-- pour partir juste après le message d'en-tête du récap (un en-tête, puis les fiches).
CREATE TABLE IF NOT EXISTS film_queue (
  chat_id    INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- new | new_dates
  header     TEXT,
  dates      TEXT NOT NULL DEFAULT '[]',
  text       TEXT NOT NULL,
  markup     TEXT,
  queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT,
  PRIMARY KEY (chat_id, item_id)
);
