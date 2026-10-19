-- #1232: what woke a product-owner triage.
--   cron        → the instance's hourly `run_po_triage` trigger, on its schedule (every row before this)
--   manual      → that trigger run by hand (run_instance_trigger / the console's Run now)
--   queue_empty → a coding run ended and the coder had nothing left to do, so it was woken at once
--                 rather than sitting idle until the next hourly window. Debounced from these rows.
ALTER TABLE po_triage_reports ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'cron';
