-- Every owner decision on a site or on the signed-in profile gets an id (#947), so a run's trace can
-- name the decision that admitted or refused a site: `policy.decision` and `review.decision` events
-- carry it as `consent_id`. A changed decision is a NEW decision and gets a new id. Rows from before
-- this migration keep NULL — they predate the trace field and are reported without one.
ALTER TABLE local_browser_domain_consent ADD COLUMN id TEXT;
