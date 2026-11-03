-- Capture time is evidence from the runner; creation and expiry remain server storage times.
-- Old frames remain unknown unless their run's durable capture event supplies the time on read.
ALTER TABLE browser_run_artifacts ADD COLUMN captured_at INTEGER;
-- A bounded, redacted control label, not a form value or arbitrary page text.
ALTER TABLE browser_run_artifacts ADD COLUMN target TEXT;
