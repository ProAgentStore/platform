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
