-- #1049: the Gmail Scout's browser source policy belongs to each instance, not the template.
--
-- 0225 (#1048) declared the Scout's local browser with `allowDomains: ["indeed.com"]` — a ceiling an
-- instance can only narrow — so a posting on SEEK, LinkedIn or any other job site was refused before
-- its owner could be asked, and the lead closed as unverifiable.
--
-- This removes that template list. The ceiling becomes "any public site", which in the local-browser
-- policy means each NEW site needs the owner's decision first: the verification dispatcher asks once,
-- durably (a `consent_required` takeover request), and the lead waits for it. Each instance then sets
-- its own allowed and denied sites (Settings → Local browser research, or MCP
-- set_instance_local_browser_settings) and per-site decisions (set_local_browser_consent).
-- Everything else in the declaration — research only, subscription only, the small limits — stays.
UPDATE agents
   SET config = json_remove(config, '$.capabilities.localBrowser.allowDomains'),
       updated_at = datetime('now')
 WHERE slug IN ('gmail-job-search-scout', 'job-search-scout')
   AND json_valid(config)
   AND json_type(config, '$.capabilities.localBrowser.allowDomains') IS NOT NULL;
