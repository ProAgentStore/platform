-- #1503: input-question delivery owns its own lease/receipt; blocker signals cannot overwrite it.
ALTER TABLE local_apply_runs ADD COLUMN input_attention TEXT;
