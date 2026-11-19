# #1484 — styled upload chooser, checkpoint approval and zero-fill reports

Real AFCA run on CLI 0.4.209 (SmartRecruiters, reached from SEEK) ended `awaiting_review` with 0 filled, 0 uploaded and
`submitAttempted: false`. A controlled real-Chromium + Playwright MCP + `ApplyBridge` reproduction found two defects.
Shipped in `d4e47612` (CLI 0.4.210) and `eaf35c4a` (CLI 0.4.211).

## What each fix does

1. **Deadlock: the styled Upload button cleared the approval its own upload needed.** A click on a button that opens a native
   file chooser invalidated the supervisor checkpoint, so `upload_artifact` then demanded another one, while the open chooser
   made `browser_snapshot` and `browser_evaluate` fail (`does not handle the modal state`). Now the approval is kept only
   when THIS click opened a NEW chooser on the SAME page (`ApplyBridge`, `browser_click`: `chooserBefore` / `chooserAfter`).
   A click that opens no chooser, or one on a different page, still invalidates it. The Stop, website-access and
   upload-format checks are unchanged and run at the upload; nothing is bypassed.
2. **Only the approved artifact reaches the exact chooser.** The generic first-input upload fallback is gone; an upload needs
   the retained chooser and the task binding, and is verified after (`generic-upload-binding.test.ts`,
   `upload-verification.test.ts`).
3. **A zero-progress run is not "awaiting review".** `request_review` from a supervisor checkpoint with nothing filled and no
   file selected now ends `blocked` with the observed reason, the checkpoint phase and "nothing was submitted"
   (`runtime.ts`, `finishSupervisorDirective`), on both the early and the waiting path (#1488).
4. **The native error is retained.** The coarse trace no longer drops it: error state, pending chooser and dialog type are
   kept, redacted, and readable through MCP (`browser_run_state`).

Fill-and-review stays non-submitting throughout.

## Tests

- `local-apply/filechooser-checkpoint.test.ts` — real Chromium: checkpoint → styled upload → `upload_artifact` with no owner
  workaround, for approved / stopped / revoked / wrong-format; exactly one checkpoint is used.
- `local-apply/bridge.test.ts` — a click with no new chooser, and a chooser on another page, do NOT keep the checkpoint.
- `local-apply/runtime.test.ts` — the zero-fill summary on both directive paths.

## Not verified here

The issue's last acceptance item — repeating the AFCA application on a delivered CLI — is a live, owner-account run and is
**pending**. Nothing in this repository proves it, and no claim is made that it has passed. A styled upload built as a
`<label for>` or a `div role=button` rather than a `<button>` has no test and is outside what the issue reproduced.
