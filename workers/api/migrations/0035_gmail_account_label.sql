-- Which account a connected provider belongs to (esp. Gmail), so the console can
-- show "Gmail (you@example.com)" instead of a bare "connected". Nullable; set at
-- connect time from the OAuth userinfo, and lazily backfilled on /v1/email/status
-- for connections made before this column existed. Other providers leave it null.
ALTER TABLE user_api_keys ADD COLUMN account_label TEXT;
