-- Record the outcome of each cached ATS run (submitted / ready / stuck / …) so the
-- learned-tips view can show what happened, and the next run sees the prior result.
ALTER TABLE ats_apply_cache ADD COLUMN outcome TEXT;
