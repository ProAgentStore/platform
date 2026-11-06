# Job application progress and remaining gaps

Recorded 6 November 2026, Australia/Melbourne. Runtime status checked at approximately 10:08 AEDT
(5 November 23:08 UTC). This is a dated assessment, not a live status page.

**We have made measurable engineering progress, but have not achieved the owner's outcome: a confirmed real job application submission.** Earlier runs were blocked by browser capabilities, observation and orchestration. The latest real HCL run got through document selection and supported answers without a command timeout, then exposed a lifecycle bug when required personal answers were missing. That bug is fixed and locally demonstrated, but the application machine has not installed the release containing it.

The work remains aligned with AI interpreting live pages rather than employer-specific automation. Execution has nevertheless drifted into repeated infrastructure repair and synthetic verification without completing the real workflow. The direct baseline should have been established earlier. Another synthetic success, release or green test suite must not be reported as the requested submission.

This record consolidates the available conversation, implementation history and retained reports. It does not reconstruct every unretained action or claim a complete security audit. The detailed design and inherited heuristic inventory remain in [browser-agent-design.md](browser-agent-design.md).

## Follow-up: runner installed, fresh application stopped in Tailor

The assessment below is preserved as the earlier baseline. At 10:35 AEDT on 6 November, the runner reported **CLI 0.4.227**, online with a successful RPC probe. Update operation `b765a18e-fd41-4fc5-8450-5fb28e82ece9` reached `restarted`. The owner authorized a cooperative pause of the active Hiring coding run; AutoPickup started a replacement, so it was temporarily disabled to let the update finish, then restored to enabled. No force-kill was used. Publication is now distinguished from verified installation.

A fresh Twinings & Co **BizTX Manager** application was selected after reading the live [SEEK posting](https://au.seek.com/job/95717400) with native Playwright and checking for an existing application. Application `22975b9d-c9dd-40e4-ada5-3724616d4f73` started at 10:36 AEDT. The public posting exposed work rights, experience, adjustments and salary questions. The selected uploaded résumé/profile were verified ready. The lead handoff still cannot carry the full job description (#1552); an attributed requirements summary was added to its supported `match_rationale` field. This is a scoped workaround, not delivery of full job-description transport.

Tailoring run `bf0119c1-eebd-4d59-a987-d4b4435a8373` froze **engine `claude`**, despite the separate browser Runner being configured for Codex. It exited with code 1, `invalid_cli_output` / `no_json_object`, and 63 raw output characters. No artifacts or browser fill were created. The redacted result does not establish the provider cause; the earlier direct Claude quota refusal is separate evidence. Retrying this document-generation failure does not replay an uncertain browser submission.

The existing Tailor settings route had no MCP control or console engine setting. [#1566](https://github.com/ProAgentStore/platform/issues/1566) adds owner-scoped MCP read/patch controls so the Tailor engine can be changed and verified independently from the Runner. Review also found that the existing local-source deletion semantics can resurrect default paths on readback; [#1567](https://github.com/ProAgentStore/platform/issues/1567) tracks that separately, and the new setter excludes source-path mutations. These controls inherit the existing route's ownership check; the route does not independently validate the instance's agent type, so the caller must identify the Tailor instance correctly.

**At this follow-up checkpoint there is still no confirmed submission, and deployed answer continuation/takeover remain untested.** The next step is to deploy the settings control, verify a Codex-only engine patch without changing document selections, and retry this same application. Its [history page](https://console.proagentstore.online/instances/2e85124f-4946-49d2-b922-8636ba92ca6a/applications/22975b9d-c9dd-40e4-ada5-3724616d4f73) is the product view; an active browser is not present while tailoring is blocked.

### 11:04 AEDT: documents generated, real form reached review, takeover return gap found

MCP 0.1.210 deployed from `dae6f869`, followed by risk-count metadata correction `8dcdcfd8`. A fresh official MCP connection discovered the new schemas under the same owner identity. Engine-only dry-run, write and independent readback confirmed Tailor `codex` while retaining machine authentication, workspace, source paths and limits. The first retry was refused by machine CPU admission. Its message promised automatic retry, but application/run readback showed no queued work; [#1568](https://github.com/ProAgentStore/platform/issues/1568) records that misleading direct-retry wording. No threshold was weakened. After the gate recovered to `accepting`, the same application was retried once.

Tailoring run `a67a2bce-4bff-4695-a5b3-a04abf04bb95` started at 10:58 AEDT with `engine.started: codex`, read the exact uploaded source versions and completed. Its résumé (`a8bbed519c7d5499228d0854d8d3d1ce21a3695e537a45d95f77acbf8d2d7af8`) and cover letter (`8061e20af70a625f53c6042227c22ac99d5d900b481bc3bc0f30f79ae89e0c10`) were read from owner-scoped cloud Files and reviewed against selected-source knowledge excerpts. No SAP, Power BI or SQL expertise was invented. The enabled connection launched fill run `5f3c8782-7ae1-4537-823e-7fc01f3e4ea4` at 10:59:32 AEDT.

The browser run recorded observed model `gpt-6-astra`, high effort, from local Codex rollout metadata; Full mode and a 600-second command timeout were frozen on the run. It reached SEEK's review page after selecting the documents and answering employer questions. Retained screenshot 16 shows the saved answers: no adjustments, AUD150,000 per year (no invented superannuation basis), permanent Australian work rights, and 8–12+ years in IT. Screenshot 20 shows review with a validation banner, so reaching review does not establish submission readiness.

An explicit owner-pause handoff succeeded on that same run at 11:01 AEDT. The owner received an active authenticated takeover link, and MCP readback confirmed `paused`, `owner_requested`, with the same run/page. **This proves handoff creation and dispatch pause, not that the owner successfully operated the browser.** Returning through ordinary `resume_application` was refused with runner HTTP409 because the live owner handoff had not been released. The console's exact handoff Resume route closes/drains control before resuming, but MCP lacked that operation. [#1569](https://github.com/ProAgentStore/platform/issues/1569) tracks exposing this existing route without restarting the application or granting submission authority.

Validation: 266 focused MCP tests passed; push checks passed (611 related tests), as did the risk-count follow-up. The local canonical full suite returned **SUITE RED: 4 failed files, 4 failed tests, 24,385 passed**. Three MCP failures read intermediate files while implementation was still being finalized; the fourth was browser teardown under high load. All four files subsequently passed on committed `8dcdcfd8` with one worker (114 MCP tests and 9 browser tests). These reruns are not a full-suite green; exact-commit CI remains the pending independent full-suite evidence at this checkpoint. There is still no confirmed employer submission.

### PDF attachment correction (#1570)

The owner identified `resume.txt` in the retained SEEK review frame. This was a platform bug: the document adapter deliberately staged approved Markdown bytes under a `.txt` filename. The earlier phrase “approved documents” described source identity, not an acceptable attachment format. It did not establish professional PDF delivery. The owner directive is now explicit in AGENTS.md and the browser design: never upload a résumé as TXT or disguised Markdown; use a real PDF, and apply the same rule to cover-letter attachments.

The generic replacement renders approved source text in a fresh offline, JavaScript-disabled print browser, before starting the employer browser or acting model. It preserves source grounding and records separate source/PDF hashes, renderer revision, PDF MIME type and byte count. Upload rechecks both identities; native upload/drop records the same provenance after successful selection. Stop aborts preparation and removes partial staging. Rendering consumes the existing run budget, with the configured command deadline (default 600 seconds); no 30-second fuse or text-file fallback was added. Existing local binary PDFs without text provenance are explicitly unsupported. No employer-specific page logic was introduced.

CLI 0.4.228 contains this change. New and queued API fills require that version or newer before browser dispatch. Publication, API deployment and installation still require separate verification. The old live run cannot acquire these PDFs merely by deploying new code.

The actual Twinings résumé and cover letter were rendered through the new production renderer. Every page was visually inspected: a two-page A4 résumé and one-page A4 cover letter, with readable text and no clipping. PDF inspection confirmed real tagged PDFs with no embedded JavaScript, forms or encryption; text extraction preserved the approved source words. This is local artifact verification, **not proof of replacement on SEEK**. Focused validation passed 276 runner/document tests and 208 API gate/application tests; runner and API typechecks, Biome and file-size checks passed. The canonical full suite is running at this checkpoint.

A later MCP read found run `5f3c8782-7ae1-4537-823e-7fc01f3e4ea4` ended as `blocked` / `incomplete`. Its final model report claimed no Submit action, but reported unresolved consent/profile discrepancies and an unconfirmed ready-for-review call. Those claims are not independently verified website facts. The explicit stop confirmation is no longer needed because there is no active attempt to stop. Read-only reconciliation `c66ae933-218e-4917-be11-512ea2c74ecd` returned **ambiguous / ambiguous_site_history**. There is no confirmed submission and this attempt must not be blindly replayed. The remaining acceptance work is to establish authoritative attempt state, install the PDF release, correct the attachments and live validation, and obtain a confirmed authorized submission.

Further inspection found a concrete limitation behind that ambiguous result: the current reconciliation runtime has no validated SEEK account/job receipt or history verifier. Repeating the request cannot resolve the attempt. The authenticated [SEEK Applied jobs history](https://au.seek.com/my-activity/applied-jobs) can provide a positive matching submission receipt, but absence alone does not prove non-submission, and the platform has no supported import path to turn an external observation into Full-mode reconciliation proof. Owner assertion does not clear that guard. [#1571](https://github.com/ProAgentStore/platform/issues/1571) tracks this separately. The existing headed browser remains reported active, but its connection is internal to the runner; this session's computer/browser access host is unavailable. No cookies/profile files were copied and no private API was used to bypass this limitation.

The full-suite run exposed three successful-dispatch fixtures that still selected CLI 0.4.225; those fixtures now use 0.4.228, while tests of the older cloud transport minimum and deliberate refusal remain unchanged. The cloud-document and new PDF-gate checks passed 35/35 on a single worker. An unrelated service-supervisor recovery test failed under heavy shared-host load and passed on an isolated rerun (27/27 file cases); its timing or assertions were not changed. These focused reruns do not turn the ongoing full-suite result into a green verdict.

### 12:07 AEDT: PDF code pushed, publication accepted, installation not yet available

Commit `0fdebde7` implements #1570; `4bf0c3b4` corrects successful-dispatch fixtures and records the reconciliation limitation. Together with exact-handoff MCP commits `d38cbab4` and `485ed507`, they were pushed directly to `main` at `4bf0c3b483dea5305a8859e4ff3298319b253f5d`. All push guards and source/test typechecks passed. Related tests passed **6,252 cases in 315 files**, with one additional skipped case/file; these are not employer submissions or a full-suite verdict.

The canonical local suite finished with the literal verdict `SUITE RED  Test Files  4 failed | 1529 passed (1533) · Tests  14 failed | 24408 passed (24430)`. Vitest's detailed report separately counts four skipped files and eight skipped tests; the wrapper's wording is retained rather than silently relabelled. Failures: three old-version cloud-document fixtures (corrected and focused checks passed), one service-supervisor timing case (27/27 on isolated rerun without changing its assertions), and ten 30-second browser-hook timeouts across generic-upload-binding and runner-browser under heavy shared-host load. The latter two files have not yet been rerun successfully for this release. New PDF/document/runtime checks passed 276/276, and the API gate/application checks passed 208/208. Do not substitute those passes for a full-suite green.

[Deploy MCP 42140443723](https://github.com/ProAgentStore/platform/actions/runs/42140443723) succeeded. Live `mcp_server_info` returned version **0.1.211**, exact commit `4bf0c3b483dea5305a8859e4ff3298319b253f5d`, 426 tools and schema revision `sha256:f7ffb4820648fe081abb055bc95c954e3d5e8cdb415cf58d88b99d305e20a864`. A fresh official MCP connection discovered `resume_application_handoff` with exact instance/run/handoff identity. No live return-through-handoff was attempted on the ended Twinings run.

[CLI publication 42140443639](https://github.com/ProAgentStore/platform/actions/runs/42140443639) succeeded, including Linux/Windows release smoke and `CLI PACKAGE GREEN 0.4.228`. Its publish log records npm accepting 0.4.228 and warning that processing may take several minutes. Independent registry lookup still returned 404 for that version and `latest: 0.4.227` at this checkpoint. Therefore accepted publication is not downloadability or installation. Supported update operation `c0e14d23-aadf-47bc-b156-1f5ccab67655` completed `up_to_date` against 0.4.227; it did **not** install the PDF fix. The runner remained online on 0.4.227 with zero application runs and one active coding turn. Nothing was force-restarted. [API deployment 42140443625](https://github.com/ProAgentStore/platform/actions/runs/42140443625) and [CI 42140443631](https://github.com/ProAgentStore/platform/actions/runs/42140443631) were still in progress.

Fresh-job research checked all 215 Scout records and 38 existing applications across both branches. Snowy Hydro and Coles were excluded after current official pages showed closure. [EPA's Head of Strategy, Products and Architecture](https://www.careers.vic.gov.au/job/head-strategy-products-and-architecture-95171) remained open: ongoing full-time in Docklands, closes 17 November, with the official three-page position description confirming standard attendance of three office days per week. Its lead `b84e2f54-e9a0-4f72-b679-56ffc8c3b770` has no application or fill attempt. Attributed selection-criteria notes and explicit limits on unsupported architecture/AI-assurance claims were added through MCP to `match_rationale`, then read back with status `new` and lifecycle version 1 unchanged. This prepares a fresh candidate; it is not an application start, blanket qualification claim or submission approval. The full-job-description handoff gap (#1552) remains.

**Outcome remains unchanged: no confirmed real submission.** Twinings has retained history but an ended uncertain attempt and expired takeover link. It must not be replayed. The next execution gate is a verified 0.4.228 installation, followed by fresh source-bound materials, live validation and a confirmed authorized submission on an eligible unattempted job.

### PDF text-fidelity follow-up (#1572)

The API deployment for `4bf0c3b4` did not ship: its test stage failed one new PDF test, with 24,418 other cases passing. Linux lacked CJK font coverage, and extraction returned two NUL characters instead of the approved characters. This is a real portability limitation, not a reason to remove the Unicode assertion or merely install fonts in CI. The successful macOS visual/text checks remain valid for those particular documents; they do not establish universal font support.

[#1572](https://github.com/ProAgentStore/platform/issues/1572) adds offline verification of the actual generated PDF's searchable text before staging. It compares owned visible document blocks in order, preserving characters within each block while allowing layout whitespace, canonical equivalents, narrowly defined Latin ligatures and generated list markers between blocks. Missing characters, empty content, sequence loss or an unreadable PDF produce an explicit refusal with font guidance. Stop and the existing rendering deadline still apply. The implementation uses the existing PDF-reader library, declared explicitly in both browser-runner and the copied CLI runtime; it downloads no fonts or external document assets. Extractable-text checks do not prove visual glyph correctness, so visual QA remains necessary.

CLI **0.4.229** carries this follow-up; the API minimum stays 0.4.228 because that minimum describes real-PDF capability. Validation: 25 focused cases passed, runner/CLI builds passed, and a clean installed tarball printed `CLI PACKAGE GREEN 0.4.229`, including an import and typed invalid-PDF refusal through the actual copied runtime. Both actual Twinings source hashes were rechecked, then freshly rendered through the verifier. All three resulting pages were visually inspected again; text remained intact and layout readable with no clipping. They are still local previews, not replacements on SEEK.

At this checkpoint the public npm registry still advertised 0.4.227 despite accepting 0.4.228 for processing. The earlier update operation was a completed no-op, not a pending installation. No new application was started while the installed runner lacked PDF support. The next delivery action is to push the fidelity follow-up and run the API deployment against that corrected commit, then verify registry availability and the effective installed runner version.

### 15:12 AEDT: PDF runner installed; fresh EPA test reached employer sign-in

The fidelity follow-up was pushed as `0c55e94024f0dbe3d73cfb9bc0c5c750210e4eb4`. Update operation `70a52ff5-ae67-4e20-88ea-c04b5b026d0e` subsequently reconciled as `restarted`, from CLI 0.4.227 to **0.4.229**. At 15:07 AEDT, independent MCP probes verified both Tailor and Application Runner online, RPC healthy and idle on 0.4.229. This supersedes the earlier installation blocker; it does not turn earlier local full-suite failures into passes.

The owner requested a real application with many fields. Public inspection followed EPA's posting into SAP SuccessFactors, company `environm01`, requisition 1743. The actual application sections are behind authentication, so their field count is **not yet verified**. The blank registration screen exposed seven required identity/password/residence controls, CAPTCHA and privacy-notice acceptance. No registration was completed during that inspection. Exact observed employer/redirect domains were added to the Runner's existing domain list through MCP; existing Full acceptance, 600-second command timeout and disabled auto-submit were retained.

After canonical duplicate checks across both Scouts found no application attempt for this job, `triage_job_lead` moved lead `b84e2f54-e9a0-4f72-b679-56ffc8c3b770` from version 1/new to version 2/apply_requested. Application `8d27faff-873e-4dd3-a2d8-00bafa258580` and Tailor run `e16d40d9-efc3-419d-8599-37bf1df1dc12` were created. The selected uploaded sources were read with their recorded hashes. Role-specific source documents were generated and subsequently read through owner-scoped MCP Files; the cover letter distinguishes proposed architecture/AI-assurance approaches from established experience.

Fill run `a071a78f-dc3d-4bae-8872-22ff3cf2cba6` on CLI 0.4.229 staged genuine PDFs before browser work. The résumé source hash is `a704fd2d68087dacc481f7721adebfd380120821241f18544576f61cd0473f7b`; its derived PDF is `a6584df4617d2f95b49510af43e7a2762d34a794a38efcafeca6b67bfdc8a3c0` (119,235 bytes). The cover source hash is `b0d909f589b98f8ddfb3a345f372a7cc49db9e6cc4f294136a9344ccacd62f32`; its derived PDF is `15969af81f6a503106faa7fbc4634b45f15876f0d9410ac67785d69e8d9b7503` (51,235 bytes). Both receipts identify `application/pdf` and renderer revision `application_pdf_v1`. These are staging receipts, **not upload acceptance or visual inspection of these exact PDFs**.

Exact local CLI metadata verified `gpt-6-astra/high`. The model navigated SEEK, followed the employer page, clicked Apply and reached `career10.successfactors.com`. After approximately 42.5 seconds of active execution it paused with `login_required`; no browser-command timeout occurred. The authenticated application fields remain untested. A supported exact-run takeover was created, expiring at 15:21:39 AEDT, and the owner received the [application history/Live browser link](https://console.proagentstore.online/instances/2e85124f-4946-49d2-b922-8636ba92ca6a/applications/8d27faff-873e-4dd3-a2d8-00bafa258580). Creation does not prove the owner opened or used it. Continuation requires sign-in and return of this same browser; no fresh replay is authorized by an expired handoff.

**Result at this checkpoint:** real PDF staging and cross-domain employer navigation verified; the requested many-field test remains pending employer sign-in. No confirmed submission, no employer upload receipt and no verified field-completion count. The older uncertain Twinings attempt was not retried.

### Authentication directive: stop treating a login page as inherently manual

The owner challenged the EPA takeover and explicitly requested the normal workflow: existing
session/login, supported passwordless or forgot-password recovery, registration only when there
is no account, and verification through connected Gmail. This is now recorded in AGENTS.md, both
project agent specs, the browser design, runtime user manual, application-profile manual and agent
README. Shared guidance is included in both guarded and Full browser prompts for CLI 0.4.230;
the Full sign-in tool description now explains broker-first provisioning rather than implying
that its pause inherently requires a person. These are instructions, not new auth operations.

Through official MCP, the previously empty account operator manual was populated with this rule
scoped to authorized job-application accounts. The Runner's stale operator manual was updated
(including its obsolete machine and site-playbook claims), and its existing Special Instructions
were preserved with an expanded authentication section. Independent readback verified all three
exact saved values. The first Special Instructions write exceeded the 4,000-character limit and
was refused without changes; the revised 3,967-character text succeeded. Existing owner facts,
unresolved screening questions and explicit submission controls were retained.

Source audit found the actual limitation: matching-host vault sign-in exists, and brokered sign-in
can receive numeric email codes, but username-only fallback is SEEK-specific. Generic reset links,
registration verification links, replacement-password provisioning and confirmed vault promotion
are not wired into application execution. `accountCreation` has no execution consumer after the
old macros were removed. MCP 0.1.212 corrects its misleading parameter description; enabling this
legacy setting is not a remedy. Existing issues [#1533](https://github.com/ProAgentStore/platform/issues/1533)
and [#1226](https://github.com/ProAgentStore/platform/issues/1226) remain open; no duplicate issue or
automatic implementation run was created. No credentials, account registrations or password resets
were changed during this instruction update.

The EPA run ended at 15:15:38 AEDT as `blocked` / `incomplete`, with nine retained native requests,
all successful, zero browser-command timeouts and no upload receipt. The engine exited without
marking review ready. Its summary says no fields/uploads/submission, but Full-mode submission
verification remains `unverified`; this is not authoritative negative submission proof. The earlier
handoff link does not establish a still-active run. This attempt was not replayed.

Validation for the authentication-guidance update: 64 MCP conformance, 22 cloud sign-in and 123
runner/tool cases passed; runner and CLI builds passed. The canonical full suite completed with
`SUITE GREEN  Test Files  0 failed | 1534 passed (1534) · Tests  0 failed | 24434 passed (24442)`.
Vitest's detailed report lists 1,530 passing and four skipped files, 24,434 passing and eight skipped
cases; the wrapper's literal wording is retained. These checks validate the existing code and
guidance integration, not delivery of the missing recovery/registration features.

### 16:34 AEDT: fresh Talent test reached final review with genuine PDFs

After the owner's request to apply again, independent MCP probes verified Tailor and Runner online,
RPC healthy and eligible on **CLI 0.4.230**. Update `ab0b4af7-0b81-4ddd-afbc-4706f3002788`
reported a reconciled restart. EPA reconciliation `b84feaf1-8742-4750-9037-937ce7e8f0f1`
remained ambiguous; that ended attempt was not replayed.

Public SEEK evidence identified Talent's **Manager - Data and Analytics Delivery**, job `95563236`,
as permanent, Melbourne hybrid, AUD172,000–180,000 plus super, with Quick Apply. Canonical pipeline
checks found no prior application for this lead. An attributed requirements summary was written only
to `match_rationale`; no lifecycle fields were forced. The apply handoff was dispatched once at
05:28:09 UTC. Application `8baaeded-3297-4a84-9613-4d5cdc877c69`, Tailor run
`c28a9bd5-66a2-41d2-a08d-80b6f8f8874b`, and fill run `ac50a3d6-a939-4d8a-aa50-cb55de3023b0`
identify this test. Its [history](https://console.proagentstore.online/instances/2e85124f-4946-49d2-b922-8636ba92ca6a/applications/8baaeded-3297-4a84-9613-4d5cdc877c69)
was supplied to the owner. No takeover was requested or claimed to have been operated.

The independent source review found the generated claims supported by the selected résumé and
current structured Profile/saved answers, including hybrid availability. No dedicated data-lake
ownership or BI-platform expertise was invented. The actual upload receipts distinguish source and
PDF identities:

| Document | Approved source SHA-256 | Uploaded PDF SHA-256 | Bytes |
| --- | --- | --- | --- |
| Résumé | `6957a675351c64620205ded7c04da5ba0ea421ef563c031549c30d0d193335fe` | `25cdbe99290a57241261f1d624c5acc522fde11ed0d60f3cb9ebbe0cad80b02a` | 127,127 |
| Cover letter | `5ccc176af2f6d4408d7c56b2747ffd8225cf20450ce0c429f2cf3c6ffd84bff0` | `cfa4f0fe514cbd2b1d52163d9955f1cc5900c720b0f6d656712b8cf9fb91b93f` | 30,201 |

Both use `application/pdf`, renderer `application_pdf_v1`. Local read-only inspection of the native
upload copies verified those exact hashes and rendered all three pages. Text is readable without
clipping; the résumé leaves the Feedzai heading/dates at the bottom of page one and its bullets on
page two. This is a pagination quality limitation, not a missing-text claim. Rendered previews are
temporary local evidence under `/tmp/pags-talent-pdf-review`, not committed private documents.
Visual inspection occurred after upload, before any authorized submission; this does **not** demonstrate
an automatic pre-upload visual-QA gate.

The acting model was observed as `gpt-6-astra`, high effort, from local CLI metadata. Full mode and
the 600-second command deadline were frozen. Nineteen retained native calls (including two internal
tab calls) succeeded with no timeout, drop or restart reported at the read checkpoint. The browser
used an existing SEEK session, uploaded both PDFs, and reached `/apply/review` at 05:31:03 UTC.
Retained frame 17 shows the correct Talent job, owner identity and both PDF filenames under
"Documents included". This establishes page acknowledgement, not employer receipt. This Quick Apply
test did not exercise a large employer questionnaire or authentication recovery.

At 05:31:30 UTC the same run paused for two substantive questions: SEEK's Asta title/dates,
UniCredit end date and Scrum Master certification year conflict with the selected résumé; additional
SEEK employment, education and achievement entries are absent from that source. The owner was asked
whether to correct the conflicts and retain the additional entries. At this checkpoint the application
is `blocked`, state version 3, while its fill run is **paused**, not ended. The recorded answer-wait
expiry is 05:49:30 UTC. No answer, resume or submission approval was fabricated. There is still no
confirmed submission; Full mode's unverified status must not be represented as proof that arbitrary
code had no external effect. The next step is exact-question answer delivery and validation in this
same run, followed by the outstanding bounded submission decision.

This is operational evidence on the existing release, with no runtime code change or new full-suite
claim. It demonstrates progress from the EPA authentication stop to final review and PDF acceptance;
it does not close authentication recovery, deployed answer continuation, takeover use or first-submission
acceptance gates.

## Original requests and present evidence

| Owner request | What changed | Status and remaining proof |
| --- | --- | --- |
| Keep applying, test failures and fix them; show the first submitted job | Repeated real runs exposed distinct failures; generic fixes and controlled tests followed | **Not achieved. No confirmed real submission in this work.** |
| Do not hardcode employer behavior into Playwright | Model-led interpretation, source-bound decisions, broader generic controls and accepted native Full mode | Latest continuation and recording changes add no employer-specific playbook. Guarded mode still contains inherited heuristics listed in the design document; the whole system is not heuristic-free. |
| Make the timeout configurable, default 600 | CLI 0.4.225 adds per-instance `browserCommandTimeoutSeconds`, range 1–3600, default 600, frozen per run | Implemented; latest real HCL run observed 600 seconds and no command timeout. This does not remove the separate whole-run or answer-wait budgets. |
| Provide application history with the last slider position being the takeover browser | CLI 0.4.225 and console changes add a distinct Live browser slot plus explicit owner-pause handoff | Implemented and covered by replay/handoff tests. A live slot alone does not grant control. This session does not establish that the owner successfully took over the HCL browser. |
| Run Claude CLI directly with native Playwright and record its actions | Direct CLI launch with a transparent local MCP recorder and native tool inventory | Attempted, but provider weekly quota rejected inference before any browser call. A Claude-versus-PAGS comparison remains incomplete. |
| Alternatively use Playwright directly | Root assistant drove native Playwright outside PAGS, opened the public HCL listing and exercised two synthetic forms | Browser primitives worked in the exercised cases. This is not autonomous Claude evidence or a real application submission. |
| Explain whether we are progressing or diverging | This dated report, evidence ledger and explicit next acceptance gates | Engineering progress is demonstrated; user-outcome progress is incomplete. |

## How we reached this point

The sequence below separates real employer evidence from local model tests. Version numbers identify capability milestones, not proof that every machine installed them.

| Stage | Observation and change | What it established |
| --- | --- | --- |
| Before the design directive | Literal preference/answer mappings, page interpretation rules and restrictive control handling existed | Some hurdles were caused by our execution layer. These rules remain documented debt, not a pattern to extend. |
| CLI 0.4.215 | Explicit acting-model/effort configuration and screenshot image transport; first employer run stopped at an uncertain checkpoint with a chooser open | Model identity could be observed. Configuring a model did not solve the interaction lifecycle. |
| CLI 0.4.216 | Upload/checkpoint instructions improved; employer visibly parsed the résumé, but the old verifier rejected the cleared file input; an experience editor was refused | The verifier and control restrictions could report failure despite useful browser progress. |
| CLI 0.4.217–0.4.219 | Native upload evidence, generic editor intent, model-named options and combobox opening improved; trace persistence repaired | Live runs verified narrower fixes, but remained partial. Counts of edits included repeated edits, not unique completed fields. |
| CLI 0.4.220 | Per-instance escalation and source-bound model decisions | A synthetic run filled known answers and deferred an unknown required fact. Autonomy cannot supply missing personal facts. |
| CLI 0.4.221 | Explicitly accepted Full native Playwright access, separate from escalation and submission | Two-form synthetic model test filled six supported answers and received image pixels. Arbitrary code introduced broader power and explicitly unverified external effects. |
| CLI 0.4.222–0.4.223 | Timeout uncertainty recovery, independent screenshots and single-flight ordering for concurrent native work | Controlled production-path tests filled fields, managed tabs and uploaded documents. These were not employer completion tests. |
| CLI 0.4.225 | Configurable 600-second command deadline, bounded optional tab-title reads, owner-pause takeover, prospective document-preflight receipts | A synthetic model test exercised six answers, two tabs and an upload. The subsequent real HCL run progressed without command timeout. |
| Real HCL run on 0.4.225 | Approved résumé and cover letter selected; supported answers completed; required salary basis and infrastructure-specific experience remained unknown | The remaining failure was final-question continuation, not the old timeout. The run ended and reconciliation remained ambiguous. |
| CLI 0.4.227 | Final mandatory questions retain the same active browser while scoped owner answers arrive | A local production-runtime model test resumed the same page and engine, filled the new answer and validated. Deployed API/MCP continuation remains to be exercised. |
| Direct baseline | Claude blocked by quota; root directly exercised native Playwright through a recording proxy | Native capability is available; there is no completed Claude comparison or valid speed comparison. |

Earlier direct-harness work reached screening but also lacked salary/disclosure/self-identification facts. Therefore there is no retained successful-submission baseline against which to claim that PAGS regressed from working end to end. There is clear evidence of individual PAGS restrictions and lifecycle defects making progress harder.

## The latest real application

The HCL attempt ran on 5 November 2026, approximately 19:58–20:01 UTC (6 November 06:58–07:01 AEDT), using CLI 0.4.225. Exact local model metadata reported `gpt-6-astra/high`; the frozen browser-command budget was 600 seconds.

Retained evidence contains 30 native requests: 29 successful and one ordinary click failure on an inactive progress control. There was no command timeout or quarantine. Both approved document selections were accepted, supported answers were completed, and screenshot pixels reached the acting model. Those facts do not establish that the whole application was ready or submitted.

Two required facts remained unresolved: the basis of the owner's salary expectation (base excluding superannuation or total including it), and years specifically working as an Infrastructure Project Manager. The agent correctly did not invent them. It incorrectly lost the continuation opportunity: final `ready_for_review` with mandatory questions ended the browser run instead of retaining it for answers.

The public [HCL listing](https://au.seek.com/job/95690358) already exposed employer questions during the later direct inspection. Discovering these before committing to an application could reduce late interruptions. That observation does not mean early question discovery or complete job-description verification has been implemented; [#1552](https://github.com/ProAgentStore/platform/issues/1552) remains the relevant follow-up in this task record.

No supervised submit was recorded. Because this was Full mode, that absence is not authoritative proof of no external effects. Reconciliation returned `ambiguous_site_history`. The old attempt must not simply be replayed or revived; the new continuation fix only applies prospectively to a still-active run.

Audit references: application `f4b8782d-583b-476a-a11a-0d7b253a37c7`; run `f0a9a234-f4b0-401e-a4ee-977c185475cc`; reconciliation `93a6f90d-6167-4225-a6c3-0b66aa8278ae`. The authenticated [application history](https://console.proagentstore.online/instances/2e85124f-4946-49d2-b922-8636ba92ca6a/applications/f4b8782d-583b-476a-a11a-0d7b253a37c7) is separate from the local diagnostic viewer.

## What the direct experiment actually tested

Claude CLI 2.1.251 was launched directly with the installed native Playwright MCP server, machine login and explicit model/permission settings. It did not use the PAGS browser bridge. The installed native browser inventory contained 45 entries, including unsafe code execution; the configured client, action and navigation budgets were 600 seconds.

The provider returned HTTP 429 with a weekly-limit message before inference: zero browser calls, zero model usage and zero fixture submissions. CLI initialization named `claude-opus-5`, but the only assistant result was a synthetic error. **No serving Claude model was verified and no Claude browser performance was measured.**

Root then used native Playwright through a local MCP recording proxy. This opened the real public HCL listing read-only and exercised two controlled forms with a fake profile. It filled seven supported/test-supplied answers, left an optional unknown nickname blank, selected a fake résumé, switched tabs, observed a required-field error, supplied the explicit dummy answer and validated again.

The direct trace has 20 requests and 20 responses: 19 successes and one file-root refusal, corrected by placing the same fake file under an allowed root. Three screenshot responses contained pixels. The fixture independently recorded zero submission POSTs. No Apply or Submit action was taken on the real HCL listing.

This shows that the exercised native controls, tabs, file upload, observation and validation flow can work without PAGS orchestration. It does not isolate model quality, establish autonomous application completion or prove that PAGS alone caused all delays. One native click took about 80.7 seconds and one snapshot about 48.7 seconds under extreme concurrent host load. Optional tab-title collection is a possible delay source, not a proven explanation for those particular timings. The experiment was not a controlled performance comparison.

The durable [recorder and viewer](../scripts/browser-baseline/README.md) forward original MCP bytes and retain request/response evidence locally. They add no employer interpretation or deadline. They record tool calls, not every operation inside arbitrary code or manual browser input. The viewer is local, read-only and process-dependent; it does not embed takeover. Raw traces may contain private page content and are intentionally not committed. The temporary viewer URL is not a durable product link.

## Why there were so many hurdles

Several different problems were repeatedly encountered as one apparent failure to apply:

1. **Execution-layer defects:** restrictions on controls, upload verification, trace writes, native request ordering, tab metadata and final-answer lifecycle. These required generic implementation fixes.
2. **Missing facts and evidence:** required personal facts cannot be inferred from adjacent experience or ambiguous salary wording. Source/job-description verification and approved-document recovery also need their own evidence.
3. **Run-state consequences:** a timeout means the caller stopped waiting, not that the browser stopped acting. Full arbitrary-code access makes the absence of a supervised submit receipt insufficient to prove that nothing was sent. Ending such a run can make retry harder.
4. **Operational interference:** shared-runner coding work delayed restart; heavy host load and unrelated checkout/test problems increased delivery time. Claude's provider quota prevented the requested direct-model comparison entirely.

The process mistake was allowing each repaired internal failure to become the next definition of success. Synthetic tests were necessary to isolate defects, but repeated successful fixtures did not close the real application loop. The direct diagnostic should have preceded much of that expansion.

Full mode is an owner-accepted change in capability, not a reliable sandbox. It removes many semantic restrictions from native interactions while increasing uncertainty about arbitrary effects. That tradeoff is intentional and documented; portraying it as both unrestricted and reliably fill-only would be incorrect.

## Timeout and continuation are separate controls

`browserCommandTimeoutSeconds` limits how long the caller waits for one native tool request. It is configurable from 1 to 3600 seconds, defaults to 600 and is frozen into new runs. The transport deadline is 60 seconds longer. Increasing it reduces premature caller expiry; it does not cancel a hung action, guarantee its completion or authorize replay. Stop and uncertainty handling remain separate.

The final-answer fix uses a different budget: one absolute wait deadline at 90% of the engine MCP budget derived from the run's `maxMinutes`. Partial answers do not reset it. Thus “600 seconds” is not a promise that a browser will wait indefinitely for human answers. The application machine's last recorded whole-run configuration was 20 minutes.

In CLI 0.4.227, final mandatory questions pause the exact active run. Answers must match the current question set, application version and pause epoch. The model receives fresh source evidence, observes the current page, fills and validates again. Stop, expired wait, lost page identity or restart ends that continuity; none silently starts a fresh application. Submission authorization is unchanged.

The local model smoke took 85.9 seconds: 13 of 13 native calls succeeded, two image responses arrived, and one browser/page/engine was preserved across the answer. Four required synthetic values were independently verified after resumption, with zero fixture submission POSTs. This exercised `LocalApplyRuntime.resume` with a synthetic supervisor, not the complete deployed API/MCP answer-delivery route.

## Delivery and validation status

The verified release evidence below belongs to commit `72747756e1217fb06edae44ab988d818cb6548db`. The repository subsequently advanced; these results must not be attributed automatically to later commits.

| Evidence | Verified result |
| --- | --- |
| [CI run 42114589490](https://github.com/ProAgentStore/platform/actions/runs/42114589490) | Success. Exact log: `SUITE GREEN  Test Files  0 failed \| 1527 passed (1527) · Tests  0 failed \| 24374 passed (24381)`. The denominator is retained as printed; it is not 24,381 passing tests. |
| Same CI browser suite | `831 passed (8.7m)`; source and test typechecks and native-browser checks also succeeded. These are repository tests, not 831 job submissions. |
| [API deployment 42114589397](https://github.com/ProAgentStore/platform/actions/runs/42114589397) | Success for the same exact SHA. Its separate test invocation reported 1,523 passing files and 24,370 passing cases; it did not emit the canonical `SUITE GREEN` line. |
| [npm publication 42114589752](https://github.com/ProAgentStore/platform/actions/runs/42114589752) | Success; package lookup verified CLI 0.4.227 was published. |
| Local focused checks | Recorder/viewer 4/4 behavioral cases; continuation boundary checks, API tests, typechecks and local model smoke passed. Five new runtime cases failed against the old source in an isolated comparison. |
| Local full-suite attempt | Interrupted under heavy load and ended `SUITE RED no report`; this was not a local full-suite pass. A later redundant local related-test run was also interrupted after remote delivery was verified. |
| Application machine at 23:08 UTC | Online, RPC healthy, CLI **0.4.225**, one active coding turn and no local application run. **The 0.4.227 continuation fix is not active there.** |
| Requested runner update | Operation `b51c10d3-a528-4aea-bd1e-207453f745f7` expired after its 21:59:03 UTC deferred lease, with no confirmed restart or final version. It is not still scheduled to install automatically. |

Earlier status showed two active coding turns; the latest check shows one. A forced restart would lose the active turn, so it was not performed. Publication, API deployment and local runner installation are distinct completion states.

Key implementation references:

| Commit | Scope |
| --- | --- |
| `99149aa5` | Owner-directed AI interpretation and model/vision requirements |
| `a3a56181` | Acting-model configuration and screenshot delivery |
| `d2b63a6e`, `52450c7a`, `d9107586`, `14fbdc2b` | Generic upload/control/option/combobox handling |
| `88e777be` | Atomic trace retention |
| `dedf7548`, `cf047978` | Escalation and accepted Full mode |
| `ca50af65`, `a1b3f8c3` | Uncertainty recovery, evidence and dispatch/reconciliation |
| `2cc870d1` | Configurable command deadline, tab metadata and combined history/Live handoff |
| `3bc9861f`, `52253e82` | Handoff frame routes and replay-pagination coverage |
| `dfe4405f`, `a9cf4a14` | Final-answer continuity and test-type correction, [#1560](https://github.com/ProAgentStore/platform/issues/1560) |
| `f15888bc` | Direct native MCP recorder and local trace viewer |

Concurrent Fleet/runner, shell-fixture and generated-asset work appeared in the same shared checkout/release range. They are not all application improvements authored by this task. Delivery encountered these unrelated checks; [#1564](https://github.com/ProAgentStore/platform/issues/1564) records the clean-checkout generated-host-assets/typecheck gap separately. No branches, pull requests, force pushes or stash restoration were used for this delivery.

## Progress versus divergence

**Progress is supported by execution evidence:** later real work got beyond earlier control/upload restrictions; the acting model and delivered pixels became observable; the 600-second configuration was verified on a real run; a concrete same-session continuation defect has a reproduction, fix and live local model test; direct native recording now exists for comparison.

**Divergence is visible in delivery and acceptance:** no confirmed real submission; the required local version is still not installed; end-to-end deployed answer delivery is untested; the direct Claude comparison did not run; early question discovery and source/document preparation remain gaps. The local diagnostic viewer is useful instrumentation but not the user's requested remote history/takeover experience. The latter must be assessed through the product's own implemented Live slot.

There is no evidence here that adding more site-specific automation would solve the remaining problems. There is also no evidence that changing the model alone would solve missing facts, lifecycle defects, runner rollout or ambiguous old attempts.

## Next acceptance gates

These are remaining work, not promises that it has already run. They keep the next iteration tied to the original outcome.

1. Install the published continuation release when the application runner can restart without losing unrelated work; verify the effective runner version through MCP. Do not count a publication or expired update receipt as installation.
2. Exercise one controlled missing-answer case through the **deployed** UI/MCP and runner, verifying the same run/page/engine, answer freshness and subsequent validation. Verify the owner can use the product history and Live takeover path on that active run.
3. Resolve required owner facts before the next real fill where the posting exposes them. Verify the posting/job description and approved document identities. Track early discovery/source quality under #1552 and approved-document regeneration under [#1553](https://github.com/ProAgentStore/platform/issues/1553), rather than silently folding them into unrelated fixes.
4. Select an eligible next application with clear attempt state. Do not replay the ambiguous ended HCL attempt merely because the continuation code changed. Preserve the owner's existing authorization and ask only for facts or decisions actually missing.
5. Run through review and authorized submission; retain a website confirmation or equivalent authoritative receipt tied to that exact job/run. This is the first acceptance gate that satisfies “first submitted job.”
6. Repeat direct Claude comparison when provider access is available, using matched facts, documents, tool inventory, scope and recorded model identity. Keep diagnostic fill-only comparison separate from an authorized real submission; compare results before adding more orchestration.

Future updates should record: baseline version, exact observed failure, smallest generic fix, independent validation, deployed runner version and real application outcome. If another iteration ends only in fixture success, record that explicitly and state which of the gates above remains unmet.

## Retained local evidence

The following files were read during preparation. They are local temporary artifacts and may be removed by machine cleanup. This report preserves their key observations; raw transport logs, screenshots, credentials and owner documents are not copied into the repository. Hashes identify the files read, not an independent attestation of their contents.

| Report | SHA-256 |
| --- | --- |
| `/tmp/pags-direct-pw-observed/report.json` | `5cfd2689a1fd7a80d3ea29868ca4ec992377f61b53ab71d13ebc41b22d82c647` |
| `$TMPDIR/pags-direct-claude-Fb4ckJ/report.json` | `3eb943118dbc11a1aa9736c9e251e84cc77b080cafa05e3604ae6985ec1b2b96` |
| `$TMPDIR/pags-live-final-answer-smoke-6rmRL2/report.json` | `25ec36fcddf61d99b4087e04f7fbd0fec57797b820cee9d7667965678fe8afd0` |

On the execution Mac, `$TMPDIR` for those reports was `/var/folders/h5/p1y3w72x0fv9kjfgh5p_csg80000gn/T/`. Reproduce future recordings using the [baseline README](../scripts/browser-baseline/README.md) with a new private output directory. Do not treat a stale local viewer link or retained screenshot as evidence of an active browser.
