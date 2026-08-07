-- A floor under the notification layer (#361), and the kind a mute is allowed to hide (#360).
--
-- `notifyUser` created a row and sent a push, every caller, every time — no coalescing, no
-- rate limit, no recent-duplicate check. The push `tag` made that look solved and did not: a
-- web-push tag collapses the OS tray VISUALLY, so N identical notifications show as one entry
-- while each still fires its own alert. #359 sent 2–4 per push through that gap; the tray was
-- the only surface hiding it.
--
--   dedupe_key  identity of the EVENT, not of the prose. `lib/notifications.ts` hashes either
--               a caller-supplied event key (a commit sha, a session handoff, a trigger id) or,
--               for a caller that has not declared one, title+body. A title compare would be
--               wrong in both directions — one deploy wears several per-workflow run numbers,
--               and two agents stuck on the same site wear identical prose.
--   pushed_at   when this row actually INTERRUPTED someone. The window is measured against a
--               push, not against a row, so a genuinely repeating event still gets through once
--               per window instead of being silenced forever by its own first copy. NULL means
--               the row was written but nothing buzzed (duplicate, or a muted type).
--   kind        'alert' = a human is blocked on it; 'update' = news. A mute never hides an
--               alert, and the console badges it.
ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
ALTER TABLE notifications ADD COLUMN pushed_at TEXT;
ALTER TABLE notifications ADD COLUMN kind TEXT;

-- The recent-duplicate lookup: one user, one key, was it pushed inside the window. Ordered by
-- pushed_at so the probe is an index-only range scan rather than a scan of the user's history,
-- which for an account with months of notifications is the difference between a floor and a
-- new latency problem on every send.
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(user_id, dedupe_key, pushed_at);
