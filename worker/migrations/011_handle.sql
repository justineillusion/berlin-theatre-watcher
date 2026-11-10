-- Pseudo (« @justine ») : pour s'ajouter entre amis dans l'app (la personne doit accepter).
ALTER TABLE users ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_handle ON users (handle) WHERE handle IS NOT NULL;
