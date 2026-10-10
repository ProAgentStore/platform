-- Exact Files provenance captured when an owner selects an uploaded Tailor source (#1004).
-- Existing selections predate hash/version metadata and are intentionally not treated as ready.
ALTER TABLE application_tailor_uploaded_sources ADD COLUMN file_version TEXT;
ALTER TABLE application_tailor_uploaded_sources ADD COLUMN file_etag TEXT;
ALTER TABLE application_tailor_uploaded_sources ADD COLUMN original_sha256 TEXT;
ALTER TABLE application_tailor_uploaded_sources ADD COLUMN extracted_text_sha256 TEXT;
ALTER TABLE application_tailor_uploaded_sources ADD COLUMN extracted_at TEXT;
