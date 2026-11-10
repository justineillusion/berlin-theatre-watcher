-- Anti-robots : un coup par demande de code / inscription, par IP et en global (fenêtre glissante, purgé après 2 jours).
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS rate_hits_key_at ON rate_hits (key, at);
