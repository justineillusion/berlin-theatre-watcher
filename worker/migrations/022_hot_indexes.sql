-- Index des requêtes jouées à chaque ouverture / rafraîchissement de l'app (ping toutes les 1–5 min, state()).
-- Sans eux, SQLite lisait la table entière : connections (côté b), notifications (💌 que j'ai envoyés), items (MAX(last_seen)).
CREATE INDEX IF NOT EXISTS connections_b ON connections (b);
CREATE INDEX IF NOT EXISTS notifications_from ON notifications (from_id, kind, created_at);
CREATE INDEX IF NOT EXISTS items_last_seen ON items (last_seen);
