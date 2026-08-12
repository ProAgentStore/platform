-- The Coder Lead can file a GitHub issue (#506).
--
-- Asked directly, twice, and told no. From `agent_trace` on instance 5fab318d (agent `coder-lead`),
-- 2026-08-10 02:20:44:
--
--   owner — "Don't you have access to github? Can't you file it directly?"
--   agent — "You're right — I can't create GitHub issues directly (I only have read tools for
--            GitHub)."
--
-- The sentence was true. Measured in production before writing this,
-- `GET /v1/instances/5fab318d…/tools`: four `github_*` reads `allowed:true`, and
-- `github_create_issue` `allowed:false, reason:"not_declared"`. The Lead then fell back to
-- `delegate_goal`, which failed for a reason with nothing to do with the request (`startWork`'s
-- per-repo single-flight: heartfull/platform was already being worked on), and the bug report was
-- written to `write_memory` as `fact:pending issue:…` with a promise to file it later. Nothing
-- schedules that promise and nothing re-reads it; the key is still there two days on.
--
-- That fallback is the argument for this migration, not against it. Filing a bug report and
-- writing code are different jobs with different concurrency, and routing the first through the
-- second means a report can only be filed while the repo happens to be IDLE. There is no version
-- of that which is correct.
--
-- ── Why this is a one-line grant and not a feature ──
--
-- No code path, no new auth, no new consent surface. The tool, its handler and its write-consent
-- gate all exist (`lib/connectors/github.ts`, `createIssueHandler`); the App token is minted by
-- `installationTokenForOwner`, which is owner-scoped, so the Lead can reach no repo the owner's
-- own GitHub App installation does not already cover. `github_create_issue` is additive and
-- reversible — an unwanted issue can be closed.
--
-- The read grant was decided once, on the pull-request question (0101: "It widens what the Lead
-- READS and nothing else"). The FILING question had never been asked at that point. It has now
-- been asked twice.
--
-- ── Why the #444 guard did not catch this ──
--
-- `lib/tool-reachability.test.ts` asks "does SOME agent declare this tool?", and `coder-repo`
-- declares `github_create_issue` — so the guard is green while this gap is live. A PER-AGENT gap
-- is structurally invisible to it, and that is not a defect in the guard so much as the limit of
-- what a catalog-wide denominator can answer. See #506 for the note; closing it needs a statement
-- of what each agent SHOULD hold, which is a product decision per agent and not derivable from
-- the catalog.
--
-- ── Deliberately NOT included ──
--
-- `github_workflow_runs` (option B on the issue — the Lead is asked "was it delivered?" constantly
-- and answers from `check_delegation`, i.e. what the run CLAIMED; CI is the independent check).
-- Real, and a separate question from the denial above — it was not asked for, so it is not taken
-- here. The issue-MUTATION tools (comment/close/relabel/assign) are #507's, and land next.
--
-- Shape follows 0101/0107/0108 (which follow 0054): `json_set` re-setting the FULL
-- `$.capabilities` object so the JSON stays one source of truth, one UPDATE, idempotent
-- (re-running writes the same value; a no-op where the agent is absent). The object below is the
-- CURRENT effective declaration — 0063 seed → 0067 → 0101 → 0107 → 0108 — with ONE name appended
-- and nothing else changed. Restating a whole object is how a sibling name gets dropped (0107 lost
-- `set_direction` doing exactly this); `coder2-parity.test.ts` is what fails if this one does.
--
-- Earlier migrations are deliberately not edited: `check-migrations.mjs --require-history` fails a
-- file whose DDL changes after the commit that introduced it, because wrangler never re-runs an
-- applied file.
--
-- REACHES LIVE INSTANCES WITH NO RE-SUBSCRIBE. `capabilitiesForInstance`
-- (`lib/agent-capabilities.ts:519-540`) JOINs the `agents` row at READ time, and `agent-think.ts`
-- resolves `toolNamesFor(capabilities)` per turn from the same source. This is NOT the #496 class
-- (identity copied into DO state at subscribe) — verified by reading both paths. The owner's
-- existing Lead picks this up on its very next turn.
--
-- SECOND STEP, OUTSIDE SQL: `github` WRITE consent must be granted for that instance (console →
-- Settings → Connections). Measured today it reads `writeConsent:"required"`, so until it is
-- granted the first call is refused — "I can't" becomes "refused", which is not obviously better.
-- The refusal is the gate doing its job (#90) and is deliberately not routed around here.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_pulls","github_read_pull","transfer_conversation","set_direction","github_create_issue"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
