-- 🎟 Réservé ! : date choisie (booked_at, « AAAA-MM-JJ HH:MM » ou « AAAA-MM-JJ »),
-- date du clic (booked_on), relance « c'était comment ? » envoyée (followup_sent).
ALTER TABLE reactions ADD COLUMN booked_at TEXT;
ALTER TABLE reactions ADD COLUMN booked_on TEXT;
ALTER TABLE reactions ADD COLUMN followup_sent INTEGER NOT NULL DEFAULT 0;
-- Invitations force_reply : « review » (avis) ou « date » (autre date de réservation).
ALTER TABLE review_prompts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
