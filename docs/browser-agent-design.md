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

## Current implementation gaps

The following was verified in the local code on 2026-11-04. These are findings, not completed fixes.

| Area | Current behavior and evidence |
| --- | --- |
| Browser engine model | [`local-browser/engine.ts`](../packages/browser-runner/src/local-browser/engine.ts), `buildEngineSpec`, accepts an engine but no explicit model input and supplies no model argument in either CLI launch. [`local-apply/engine.ts`](../packages/browser-runner/src/local-apply/engine.ts) delegates to that launcher. This path alone cannot establish which model actually ran. |
| Acting model's vision | [`local-apply/bridge.ts`](../packages/browser-runner/src/local-apply/bridge.ts), `APPLY_BRIDGE_TOOL_NAMES` and `listTools`, expose a filtered tool set without `browser_take_screenshot`. [`local-browser/replay.ts`](../packages/browser-runner/src/local-browser/replay.ts) records screenshots as replay evidence. Those saved frames do not, by themselves, reach the application model. The owner-facing MCP screenshot reader is a separate capability. |
| Question-to-memory mapping | [`instance-preferences.ts`](../packages/browser-runner/src/instance-preferences.ts), `preferenceField`, interprets English question wording using regular expressions. Its source-precedence checks and its question interpretation are currently coupled. |
| Particular answer mapping | [`local-apply/citizenship-option.ts`](../packages/browser-runner/src/local-apply/citizenship-option.ts) recognizes a specific combined citizenship option and particular source-text shapes. This is not a general semantic mapping mechanism. |
| Form controls | [`local-apply/bridge.ts`](../packages/browser-runner/src/local-apply/bridge.ts) uses pagination and form-step name patterns. Its selection path can forward a custom combobox to the native select tool, while its click policy can refuse a custom control. |
| Page-state interpretation | [`local-apply/bridge.ts`](../packages/browser-runner/src/local-apply/bridge.ts), [`confirmation.ts`](../packages/browser-runner/src/local-apply/confirmation.ts), [`unavailable.ts`](../packages/browser-runner/src/local-apply/unavailable.ts), and [`sign-in-policy.ts`](../packages/browser-runner/src/local-apply/sign-in-policy.ts) contain page-text, URL, control-label or page-structure interpretation rules. |
| Safety and sign-in | [`commit-guard.ts`](../packages/browser-runner/src/commit-guard.ts) mixes deterministic form facts with committing-action vocabulary. [`site-session.ts`](../packages/browser-runner/src/local-apply/site-session.ts) and the apply contract contain particular-site sign-in behavior. These require a planned replacement, not an unreviewed removal. |
| Missing validation evidence | [Issue #1510](https://github.com/ProAgentStore/platform/issues/1510) records an employer-side field error absent from the application timeline. The model later advanced, but the original trace did not explain the rejection or recovery. |

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
