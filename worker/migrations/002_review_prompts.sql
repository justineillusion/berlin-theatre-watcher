-- Invitations à laisser un avis (force_reply) : plusieurs ouvertes à la fois,
-- une réponse est rattachée à SON item via reply_to_message.message_id.
CREATE TABLE IF NOT EXISTS review_prompts (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  closed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS review_prompts_open ON review_prompts (chat_id, closed, created_at);
