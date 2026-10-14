-- #1062: the legacy cloud-brain Job Application Assistant (JOB_APPLY) is SUPPORTED again.
--
-- 0189 drafted its catalogue row on 2026-10-08 as part of retiring the workflow. The owner corrected
-- that on 2026-10-14: "legacy" never meant retired. JOB_APPLY is a supported browser-work path
-- alongside the Scout → Tailor → Runner pipeline, so the row is published again and can be
-- subscribed to. Nothing else about it changes: its declared capabilities (surfaces ["apply"],
-- runtime "browser", workflow JOB_APPLY) already set it apart from the pipeline's local runtimes.
--
-- Additive and idempotent: only this one row's visibility, and only from the draft 0189 left.
UPDATE agents
   SET visibility = 'published',
       updated_at = datetime('now')
 WHERE slug = 'job-application-assistant'
   AND visibility = 'draft';
