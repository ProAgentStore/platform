-- #841: the raw broker capability must survive a runner reconnect, but never in a
-- Durable Workflow payload. Store it envelope-encrypted and erase it on terminal
-- job transition (lib/website-builder-jobs.ts).
ALTER TABLE website_builder_jobs ADD COLUMN token_ciphertext BLOB;
ALTER TABLE website_builder_jobs ADD COLUMN token_dek_wrapped BLOB;
ALTER TABLE website_builder_jobs ADD COLUMN token_iv BLOB;
