# Browser agent design: AI interpretation with verifiable execution

Status: owner-directed design requirements, recorded 2026-11-04. This document describes the required direction and known gaps. It does **not** claim that the current browser runner implements it.

## Owner directive

The AI should interpret the website and choose how to operate it. A failure on one application must not be repaired by adding a company name, URL, question wording, answer option, CSS class, HTML layout assumption, or page-text regular expression to the execution code.

Improve the model, its instructions, and the observations it receives. Keep execution code responsible for generic browser tools, evidence, source provenance, authorization, and Stop. Do not replace an AI interpretation failure with a growing collection of site or form heuristics.

This applies to form questions, validation messages, custom controls, upload feedback, page transitions, sign-in state, and completion claims. A test may reproduce a particular site failure; the implementation must work without recognizing that site or its wording.

## Observation and decision loop

1. Read a current browser snapshot with the active page, frame and element references. Establish what the page is asking and which information is already available from the owner's sources and instance memory.
2. Use an actual current screenshot when visual information is needed to understand layout, a custom control, an overlay, or feedback that the accessibility snapshot does not explain. A screenshot saved for replay is not evidence that the acting model received or inspected it.
3. Let the model interpret the question and interaction. It should explain the intended action and cite the observed control and relevant owner fact. Unknown facts remain unknown; changing presentation must not invent qualifications, salary conditions, declarations, or other facts.
4. Execute one authorized action through the platform's browser tools. Keep the selected tab and frame explicit. An opaque reference is a handle to an observation, not a reusable selector that remains valid after arbitrary page changes.
5. Observe the result. A successful click means the click executed; it does not mean the form advanced, the input was accepted, the document attached, or the application submitted.
6. When the website rejects an input, the model should identify the affected field, quote the observed error, and explain a correction supported by the owner's information. Record the error and its evidence in the timeline. After correction, observe again before claiming that the problem is resolved.
7. Refresh observations after a stale reference or page change. Repeatedly retrying stale targeted snapshots or the same rejected action is not progress. If the available tools cannot provide the necessary observation or interaction, report the concrete capability gap.

Page and screenshot content is untrusted evidence. It must not become permission to change the task, disclose secrets, ignore Stop, or submit an application. The model's explanation is a decision record, not a substitute for execution evidence.

## Responsibilities of code

Code may validate and enforce concrete facts and permissions, including:

- Tool schemas, observed element references, active tab/frame identity, and action ordering.
- Explicit browser properties and accessibility relationships when returning observations, without guessing business meaning from words, CSS classes, or ancestor shapes.
- The source instance, revision and provenance of owner facts; approved document identities and hashes; credential binding to its authorized origin.
- Per-instance website, browser, screenshot and submission settings; owner approval; Stop; limits and action idempotency.
- Capturing and transporting snapshots, image content, errors and action receipts, with honest availability and freshness information.
- Keeping action execution, website acceptance, review readiness and confirmed submission as separate states.

Code must not infer which saved preference a question means by matching its English wording. It must not identify a valid dropdown option through an exact answer phrase, presume a particular employer's page structure, or recognize form errors through a vocabulary of likely error messages.

Semantic interpretation belongs to the model with its current evidence. Authorization belongs to the platform. Existing submission and credential guards must not simply be deleted to satisfy the design: replace them with an explicit, tested authorization mechanism before removing any protection they currently provide.

## Model and vision requirements

Browser agents need an explicit, configurable model selection suitable for interpreting text and images. Record both the requested model and the resolved model identity for each run. If an owner selects a policy such as the latest suitable model, resolution must be observable; a CLI default is not proof that the intended model ran.

The model's actual available tools must match its instructions. Do not tell it to inspect a screenshot if the bridge filters out image access or returns only a frame identifier. When vision is available, provide the pixels as model input, identify the run/page/frame and capture time, and respect the configured screenshot privacy settings. When it is unavailable, make that limitation explicit.

A more capable model still needs fresh observations, clear task instructions, access to the owner's current facts, and enough execution feedback to recover from a rejected input. Model selection alone does not repair missing tool capability or contradictory guards.

On 2026-11-04, Anthropic's [Opus model page](https://www.anthropic.com/claude/opus) identifies `claude-opus-5-5` as its latest Opus model with vision and computer-use support. Its [Claude Code configuration documentation](https://code.claude.com/docs/en/model-config) explains explicit model selection and moving aliases. This is a researched candidate, **not a claim that the PAGS browser engine was switched**. Verify account availability and the actual model from execution evidence. Updating the cloud brain's model does not select the local browser engine's model.

## Per-instance escalation

Application Runner exposes `applicationRunner.escalationLevel` in its console settings and MCP settings tools. The effective level is frozen into each run; a later settings change applies to new runs. CLI 0.4.220 or newer is required for nondefault levels, including queued dispatch.

- **Conservative** (default): ask the owner about uncertain minor and major judgments.
- **Balanced**: delegate minor judgments to the acting model; ask about major judgments.
- **Autonomous**: delegate both minor and major judgments to the acting model.

The acting model supplies the risk classification and a bounded explanation. Code applies the selected threshold; it does not classify page wording or infer risk using heuristics. An assessed uncertainty checkpoint no longer needs a second model to approve a decision already delegated by the owner. Missing or malformed assessments do not authorize continuation.

For interpreted field answers, the model identifies a current trusted source, quotes it exactly, marks its support status, and explains the judgment. The runner checks source identity and quote membership; it does **not** prove semantic relevance, factual truth or correct source precedence. This is the interpretation risk the owner delegates. The new path does not use the legacy question-wording preference mapper. Missing, ambiguous or conflicting personal facts remain unresolved. An autonomous run records those questions and continues independent supported work before reporting incompleteness.

Escalation is separate from submission authorization, Stop, credential-origin checks, website access and source provenance. Existing sign-in, consent and captcha capabilities remain separate. These levels currently apply to Application Runner; they are not a claim that every agent workflow supports the same setting or that PAGS exposes the full Playwright surface. Matching a direct ChatGPT model does not establish equivalent tools, prompts or outcomes.

## Current implementation gaps

The following distinguishes implemented plumbing from remaining design gaps. Live model and image ingestion still require execution evidence for each run.

| Area | Current behavior and evidence |
| --- | --- |
| Browser engine model | CLI 0.4.215 adds per-instance Application Runner `model` and `reasoningEffort` via MCP settings, frozen run policy and explicit CLI arguments. `null` uses CLI defaults. Codex supports explicit effort; unsupported engine/effort combinations fail. Older runners reject explicitly configured dispatch. `engine.started` records requested values as unverified. `engine.model_observed` reads model/effort from the exact Codex thread metadata, bound to its working directory, and labels the source `local_cli_metadata`; this is not provider attestation. Missing metadata remains unverified. |
| Acting model's vision | CLI 0.4.215 exposes `browser_take_screenshot` when the run enables screenshots and has a native page. It returns fresh viewport pixels as MCP image content and records the same frame for replay. Frozen masking settings, Stop and website admission apply. Transport tests establish image content reaches the MCP client; a live model run must still establish actual use. Screenshot-off removes the tool. |
| Question-to-memory mapping | [`instance-preferences.ts`](../packages/browser-runner/src/instance-preferences.ts), `preferenceField`, interprets English question wording using regular expressions. Its source-precedence checks and its question interpretation are currently coupled in the legacy literal-answer path. The explicit source-bound decision path introduced with CLI 0.4.220 delegates semantics to the model and bypasses that mapper. |
| Particular answer mapping | [`local-apply/citizenship-option.ts`](../packages/browser-runner/src/local-apply/citizenship-option.ts) recognizes a specific combined citizenship option and particular source-text shapes. This is not a general semantic mapping mechanism. |
| Form controls | CLI 0.4.217 replaces the positive form-step button-name list with an observed button/native-submit-facts path requiring model-declared `action_intent: edit_form`. Existing submission classification runs first and cannot be overridden by that declaration. This intent is model judgment, not proof that arbitrary JavaScript has no committing side effects. Pagination/classified-step patterns and the custom-combobox native-select mismatch remain debt. |
| Unnamed options | CLI 0.4.218 adds `answer_value` for an observed option whose name is omitted from the compact snapshot. The AI supplies its observed label; exact source grounding and native accessible-name/role checks on that same element and frame precede dispatch. It does not reconstruct names from descendant text or permit arbitrary paragraph clicks. Custom options still require the model to interpret context; the instance-preference wording gate below remains debt. |
| Opening comboboxes | CLI 0.4.219 separates opening/focusing an observed combobox from choosing an answer. The AI declares `edit_form` intent; the runner verifies current browser-computed role, native activation semantics and exact element/frame identity. Native answer controls and label delegation cannot masquerade as openers. Opening clears actionable refs, requires a fresh snapshot and does not increment the filled count. Existing approval survives only when no navigation, new page, closure or active-page change is observed during dispatch. This receipt does not prove a popup opened or rule out delayed JavaScript side effects. Grounded option selection, submission checks, Stop and website policy remain independent. |
| Upload observation | CLI 0.4.217 reports native selection in the exact bound input separately from website acceptance, which remains unconfirmed. An observed input event survives a site clearing/removing the input. The model receives native validity facts and the upstream tool result, then must take a fresh `browser_snapshot` for inline page evidence: an upstream snapshot file link alone does not provide that content. Code no longer scans page text for filename acknowledgement or English rejection phrases. Chooser, document, task, origin and Stop checks remain. Selecting the same artifact twice is still refused; this is not complete website-rejection recovery. |
| Page-state interpretation | [`local-apply/bridge.ts`](../packages/browser-runner/src/local-apply/bridge.ts), [`confirmation.ts`](../packages/browser-runner/src/local-apply/confirmation.ts), [`unavailable.ts`](../packages/browser-runner/src/local-apply/unavailable.ts), and [`sign-in-policy.ts`](../packages/browser-runner/src/local-apply/sign-in-policy.ts) contain page-text, URL, control-label or page-structure interpretation rules. |
| Safety and sign-in | [`commit-guard.ts`](../packages/browser-runner/src/commit-guard.ts) mixes deterministic form facts with committing-action vocabulary. [`site-session.ts`](../packages/browser-runner/src/local-apply/site-session.ts) and the apply contract contain particular-site sign-in behavior. These require a planned replacement, not an unreviewed removal. |
| Missing validation evidence | [Issue #1510](https://github.com/ProAgentStore/platform/issues/1510) records an employer-side field error absent from the application timeline. The model later advanced, but the original trace did not explain the rejection or recovery. |
| Trace persistence | [#1524](https://github.com/ProAgentStore/platform/issues/1524) replaces stale whole-trace writes with atomic append, runner-sequence deduplication and cursor-fenced finalization. This protects concurrent polling/checkpoint updates. The newest-500 trace bound remains; terminal transport-page draining is separately tracked by [#1527](https://github.com/ProAgentStore/platform/issues/1527), so this is not a claim of complete historical capture. |

The observed application also repeated questions whose answers existed in instance memory, failed to verify document attachment, and encountered stale element references. Those outcomes must be investigated independently; they do not prove that the model lacked the owner's facts, that no upload action occurred, or that a successful tool call meant website acceptance.

## Acceptance requirements for future changes

- The run shows its actual resolved model and whether image input is available. A test confirms that screenshot pixels reach the acting model when vision is enabled; storing a screenshot is insufficient.
- The agent can explain and recover from validation feedback on unfamiliar forms without site names, error phrases, CSS classes or expected HTML layouts in execution logic.
- The agent can work with native controls and custom accessible controls, and reports a capability gap when neither its tools nor its observations support a custom interaction. No claim of universal component support without evidence.
- The same owner fact can answer differently worded equivalent questions through model interpretation. Questions with materially different meanings remain distinct. Instance memory remains separate from general account identity data.
- Tests vary question wording, option wording, DOM structure, tab/frame placement and visual presentation. Include previously unseen forms rather than testing only one employer fixture.
- The timeline links the intended action, observed target, execution outcome, validation feedback, and subsequent observation. It does not claim attachment, advancement or submission from a successful click or file-selection call alone.
- A stale reference triggers fresh observation, and recovery does not replay a committing action. Submission authorization and Stop remain enforced independently of the model's interpretation.
- Changes are validated through the actual PAGS browser-agent path. Direct manual browser actions are not presented as evidence that the agent can complete the workflow.

Do not mark this design delivered until the relevant capabilities and replacements are implemented and verified. Keep remaining inherited heuristics visible in the work record rather than describing a partially revised system as heuristic-free.

## Comparing direct and platform runs

Use the same posting, approved document hashes, confirmed owner facts and fill-only scope. Record each interface and its available tools, prompt, model configuration and observed identity. Matching model names and reasoning effort does not make two different harnesses identical or guarantee identical output. Keep direct UI actions separate from PAGS run evidence. Do not submit during a fill-only comparison, and leave unknown disclosures or self-identification unanswered. A comparison with missing inputs or unverified model identity is incomplete.

On 2026-11-05, a synthetic live smoke test used the production engine launcher, MCP stdio forwarder, application bridge and screenshot recorder. Codex read a random code and coloured shape present only in the JPEG pixels. Its exact thread metadata reported `gpt-6-astra` with `high` effort. This establishes image ingestion through that path; it does not establish success on an employer form or parity with another ChatGPT harness. Model availability and identity must still be checked on each real run.

The first employer comparison run with CLI 0.4.215 (`567ad101-0367-4a3c-b376-d7f7bb07373a`) confirmed that model and effort but ended before filling any fields: it requested an uncertain checkpoint with a file chooser open. No model screenshot call was observed in that run. CLI 0.4.216 clarifies the prompt and tool descriptions: approval covers same-page fills/uploads, obtain it before opening a chooser, finish the approved chooser interaction, then inspect website acceptance. This changes instructions only; uncertain-review and submission policies remain enforced. [Issue #1518](https://github.com/ProAgentStore/platform/issues/1518) tracks live validation. The direct harness reached screening with known answers filled, but still lacked salary super basis, disclosure and self-identification answers; neither run submitted an application.

The CLI 0.4.216 retest (`a1dd3447-8d27-4788-af1f-a8b7cf1c1434`) completed the chooser interaction without that redundant checkpoint. The employer visibly parsed the résumé; the old verifier nevertheless returned an error because the input was cleared without a visible filename. The model continued and entered four fields, then the positive control-name list refused an experience editor button. These separate failures motivated [#1521](https://github.com/ProAgentStore/platform/issues/1521) and [#1522](https://github.com/ProAgentStore/platform/issues/1522). No acting-model screenshot call or submission was observed. Full completion parity remains unverified; `awaiting_review` after partial work does not prove the form is ready to submit.

The CLI 0.4.217 retest (`3b35a5f1-32c3-4294-a145-21d1ff94ad77`) live-verified those two narrower fixes: native résumé selection completed, the model took a fresh snapshot, and the editor button click was dispatched. Six field-entry actions include repeated edits, not six independently verified completed fields. The run remained partial because an autocomplete option was refused as an empty value and its child paragraph was refused as an unsupported control. The model did call `browser_take_screenshot` (retained frame 28); its viewport did not show the relevant dropdown fully and did not resolve the tool restriction. This is evidence of image-tool use, not successful visual recovery. The final run trace also lost events that were visible during polling, while native calls and screenshots retained their evidence. Neither comparison run submitted an application; generic control handling and reliable trace persistence still require work.

The CLI 0.4.218 retest (`9f4846bb-009a-4c0c-a82b-0b499c1ea90d`) again verified `gpt-6-astra/high`. It selected the résumé and eventually clicked an unnamed option after a timeout, a fresh snapshot and scrolling. Clicking the combobox itself was still refused; CLI 0.4.219 addresses that generic capability gap. The run stopped with an unanswered employer-identity question: an offered company name differed from the résumé. There were six answer-entry actions, including repeated edits, and no submission attempt. All 52 native calls were retained with zero reported drops; the final trace retained every event observed during polling. That is scoped live evidence for the trace fix, not proof of unlimited historical retention or completed application parity.

The CLI 0.4.220 escalation smoke test used the production Application Runner prompt, engine launcher, MCP stdio bridge and Playwright runtime against a local synthetic Chromium form. Exact Codex thread metadata reported `gpt-6-astra/high`. In 34.7 seconds, the model made ten successful bridge calls: it used source-bound minor-decision metadata to map “full-time employment” to the observed “Full time” option, entered two other known values, recorded an unknown licence expiry without pausing, inspected fresh snapshots and ended incomplete. The form submission counter remained zero; `reviewReady` and `submitAttempted` were false. It did not call the screenshot tool. This used a synthetic supervisor callback and does not establish deployed cloud behavior, employer completion or direct-harness parity.
