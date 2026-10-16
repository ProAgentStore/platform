# #1068 — delivery record

**Issue:** Application Runner: the owner is never told when a fill run ends `submit_unconfirmed`, and
the Console cannot start the #1013 read-only check (sign-in handoff).

**Status:** delivered. The issue's "First slice (this issue)" was two parts, **A** and **B**. Both
shipped in `36d5377c` (2026-10-14). That commit's CI, Deploy API Worker and Deploy Host Worker runs
all succeeded (38541061479, 38541062083, 38541061685). Reconciled against `main` at `40a85bfb`
(2026-10-17): both parts are present and tested there, and no new code was needed.

## What shipped

| Part | Commit | Where | Tests |
|---|---|---|---|
| **A** — owner alert when a runner result settles an application to `blocked`/`submit_unconfirmed` (`decision_required`, once per state version, under the owner's notification policy, no retry offered) | `36d5377c` | `workers/api/src/lib/local-apply/apply.ts` (`notifyUncertainSubmit` call), `workers/api/src/lib/local-apply/handoff-notification.ts` (durable-row re-check) | `workers/api/src/routes/application-runner-routes.test.ts` |
| **B** — Console "Check the employer's site (read-only)". It drives `POST …/application-runs/:runId/reconciliation` and opens the #1013 read-only handoff (`…/reconciliation/handoff`) on a sign-in or CAPTCHA. It never fills, submits, retries or clears the uncertainty. | `36d5377c` | `store/console/src/tabs/ApplicationsTab.tsx`, `store/console/src/lib/applications.ts` (`canCheckSubmission`, `reconciliationSentence`) | `store/console/src/lib/applications.test.ts`, `e2e/applications-check.spec.ts` |

## Related work that is not #1068's

- **#1107 (`5539750b`)**:
  - stage-by-stage `run_progress` updates and a one-time `run_stalled` alert;
  - blocker pushes (`workers/api/src/lib/applications/run-signals.ts`), including `decision_required` for an `auto_submit` run that was lost or timed out (`submit_state_unknown`).

  It does not send a second `submit_unconfirmed` notification; that stays A's.
- **#1073**: the owner's one-shot `assert_not_submitted` ("I checked the employer site and nothing
  was submitted", `workers/api/src/lib/local-apply/owner-assertion.ts`). This is the owner's way
  forward after a check. A reconciliation proof alone never makes an attempt retryable, by #1013's
  design.

## Follow-ups (outside #1068, to be tracked as their own issues)

1. **`auditReconciledNoSubmission` has no production caller.** It is defined in
   `workers/api/src/lib/local-apply/store.ts` and referenced only by
   `workers/api/src/lib/local-apply/reconciliation-store.test.ts`. A proof of no submission is
   stored in `local_apply_reconciliations`, but the application's lifecycle audit never records the
   `submit_unconfirmed_reconciled_no_submission` transition. This is a #1013 gap.
2. **Should reconciliation accept `submit_state_unknown`?** The route
   (`workers/api/src/routes/instances-application-runner.ts`) refuses everything except the exact
   ended `submit_unconfirmed` attempt: `blocked` / `submit_unconfirmed` / `submitAttemptedAt` set
   / run `blocked`. A lost or timed-out `auto_submit` run is `failed`, with
   `blockReason: submit_state_unknown`, and may never have pressed submit. Widening that gate
   changes a deliberate #1013 safety rule and needs the owner's approval.
3. **SEEK.**
   - Under `fill_and_review`, SEEK's "Quick apply" is refused as a one-click send, so a review run
     cannot open the form. That needs a decision on a site-specific entry rule.
   - A SEEK history/receipt adapter for reconciliation needs an authorized inspection of the real
     site.

**Not verified:** a live end-to-end run on a real SEEK application. A and B were tested against
mocked Runners only.
