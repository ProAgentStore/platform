-- Store a deep-link target on each notification so tapping it (in the bell
-- history OR a web push) opens exactly the right place — e.g. the repo's Agent
-- chat that produced it — instead of the generic notifications page.
ALTER TABLE notifications ADD COLUMN url TEXT;
