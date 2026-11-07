-- #1605: what pushing a Scout's leads to the Jobs app did during a scan ({sent, failed, reason}).
ALTER TABLE gmail_scout_scan_receipts ADD COLUMN jobs_push TEXT;
