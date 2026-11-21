-- #1684: GET /v1/notifications ordered by created_at DESC, id DESC, but the only user index (user_id, read, created_at)
-- cannot return rows in that order, so every list call sorted all of the user's notifications (~57K rows/call) in a temp b-tree.
-- Full list: seek the user, read the first page in order.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC, id DESC);
-- ?unread=true: seek (user, unread), read the first page in order, never walking the user's read rows.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created ON notifications(user_id, read, created_at DESC, id DESC);
