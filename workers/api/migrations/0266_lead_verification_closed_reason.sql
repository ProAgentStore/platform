-- #1235: a lead closed ONLY because its site was never allowed in time can be reopened once it is.
--
-- The owner-selected Coles SEEK lead 54411cad… waited for site consent; when the 60-minute wait ran out it
-- became terminal `unverifiable` with a refused receipt and no run, and "Verify now" refused it for not
-- being `awaiting`. Nothing on the row said WHY it closed, so it could not be told apart from a runner,
-- network or protocol failure that must stay closed.
--
-- `closed_reason` = 'consent_expired' marks exactly that closure; every other close leaves it NULL.
ALTER TABLE job_lead_browser_verifications ADD COLUMN closed_reason TEXT;

-- Leads already closed this way. Matched on the refusal sentence the dispatcher itself wrote
-- (`sourceGate`: "Nobody allowed <host> within <n> minutes, so it was not opened."), and only where no
-- browser run was ever dispatched or completed for the lead — so an attempted lead is never marked.
-- Two short patterns, not one: D1 refuses a LIKE pattern over 50 bytes ("LIKE or GLOB pattern too complex").
UPDATE job_lead_browser_verifications
   SET closed_reason = 'consent_expired'
 WHERE state = 'unverifiable'
   AND attempts = 0
   AND last_detail LIKE 'Nobody allowed % within % minutes%'
   AND last_detail LIKE '%, so it was not opened.%'
   AND NOT EXISTS (
     SELECT 1 FROM job_lead_browser_verification_attempts a
      WHERE a.instance_id = job_lead_browser_verifications.instance_id
        AND a.lead_id = job_lead_browser_verifications.lead_id
        AND a.state IN ('dispatched', 'completed', 'no_runtime')
   );
