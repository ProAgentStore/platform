/**
 * The published surface, hashed, keyed by the version that published it (#573 AC2).
 *
 * ── What this closes
 *
 * #573 made `serverInfo.version` and `server.json` read from one constant, so the four
 * statements of the version can no longer disagree. What it did NOT do is make that number
 * move. Four statements agreeing at `0.1.1` is the correct resting state and is also exactly
 * what the repo looked like through #561's four commits, which between them annotated all
 * 135 tools, added a server `instructions` string and changed `my_instances` from a bare
 * array to `{"instances":[…]}` — a consumer-visible shape change — while every version
 * statement sat still.
 *
 * A caching host is the reason this matters. Hosts cache the tool list; the ProAgentStore
 * connector in ChatGPT served the pre-`b2b0ac4` unannotated list until someone refreshed it
 * by hand. (Standard host behaviour, and stated as such: that a bump would specifically have
 * made OpenAI's client re-fetch was never tested against it.)
 *
 * ── DECISION 1 — what is IN the fingerprint
 *
 * **Everything a client receives, except `description`.** Not a list of fields, deliberately:
 * a list would drift from what the SDK actually publishes, and this whole ticket is about two
 * hand-maintained restatements of one fact. The hash is taken over the real `tools/list`
 * objects with `description` deleted, plus `SERVER_INSTRUCTIONS`. A field the MCP SDK starts
 * publishing tomorrow is inside the fingerprint the day it appears, with nobody remembering
 * to add it. In practice that covers the tool NAME set, `inputSchema`, `annotations`,
 * `outputSchema` and `title` — which is what `MCP_SERVER_VERSION`'s own docstring already
 * says the surface is, and the two must not be allowed to disagree.
 *
 * `description` is excluded, and this is a decision rather than an oversight: a description
 * is prose a model reads, not a contract a client builds against. #565 rewrote
 * `usage_summary`'s description hours before this landed and correctly did not bump the
 * version. Making every wording fix a version bump trains people to skip the bump, which
 * costs more than it buys.
 *
 * ── DECISION 2 — what happens on a mismatch
 *
 * It FAILS, and says "the surface moved; bump `MCP_SERVER_VERSION` and add its entry here".
 * It does not bump anything itself. An auto-bump changes the number without anyone deciding
 * it changed, which is how a version stops meaning what it claims to mean — and this file
 * exists because a version stopped meaning anything.
 *
 * ── What this DOES and DOES NOT guarantee
 *
 * It makes a surface change impossible to ship SILENTLY: the build goes red and the failure
 * names the version bump as the fix. On its own it did NOT prove the version moved, because
 * the entries below could be edited in place instead of appended to — and that was not a
 * theoretical hole. Measured on 2026-08-15 (#576): one sentence appended to
 * `SERVER_INSTRUCTIONS` plus an in-place rewrite of the `0.1.2` entry passed all twelve
 * other CI gates, because nothing else in the repo compares `SERVER_INSTRUCTIONS` to
 * anything.
 *
 * `scripts/check-surface-lock.mjs --require-history` closes it: the map is APPEND-ONLY, and
 * an entry that changes or disappears after being recorded fails CI. That is why the lock is
 * keyed BY VERSION rather than being a bare hash — the shape is what makes the invariant
 * expressible. Adding a version is free; rewriting one is a claim about an artefact already
 * published to the MCP registry, and is refused.
 *
 * ── Regenerating
 *
 * Do not hand-edit a hash. Run `pnpm vitest run workers/mcp/src/conformance.test.ts` — the
 * failure prints the computed value. Then bump `MCP_SERVER_VERSION` and add a NEW entry.
 */
export const SURFACE_LOCK: Record<string, string> = {
	// The surface as published at 0.1.1 — 135 tools, `readOnlyHint`/`destructiveHint`
	// throughout, `outputSchema` on `list_agents` and `my_instances`, and the server
	// `instructions` added by 951ef59. Recorded, not chosen: it is what the code served.
	//
	// Kept now that 0.1.2 supersedes it. Only the CURRENT version's entry is compared, so a
	// past entry does nothing mechanically — it is here so that changing one is a visible act
	// rather than a one-line "update the fingerprint".
	"0.1.1": "sha256:e48a4a9e57dfd0c14043ed08d1698ee48fae5748eb4e4b96112c6be39b323f89",
	// 0.1.2 (#574): `create_instance_task` and the other write tools gained an argument
	// saying where the result is readable, which is an `inputSchema` change and therefore a
	// surface change. That bump was made BY HAND, correctly, hours before this ratchet
	// landed — and this entry is the first thing the ratchet ever demanded, since rebasing
	// onto it failed with "surface-lock.ts has no entry for MCP_SERVER_VERSION 0.1.2".
	"0.1.2": "sha256:fa4b1a42a18b7b0bc9f52f81d4443b6a934a898bf0e1fcd1dcaf9d0d610405bb",
	// 0.1.3 (#581/#527): `coding_timeline` registered, the first MCP reader of the
	// `coding_timeline` table — a NAME added to the surface-gated coding group, which is the
	// first bullet of `MCP_SERVER_VERSION`'s own list. The three description changes that came
	// with it (`check_instance_loop` and `coding_loop_status` no longer implying they speak for
	// the engine, #580 AC3; `coding_session_capture` saying an ended session's empty pane is not
	// evidence of an idle run) are NOT what moved this hash — descriptions are excluded from the
	// fingerprint on purpose. Appended, never edited in place: 0.1.2 is published.
	"0.1.3": "sha256:f3cc58b5e73ffe3c9a6457a21ea247b971cba7af9fa7ba6c122f89f6ef86e682",
	// 0.1.4 (#578): `list_instance_tools`'s `schemas` argument reworded — it claimed schemas were
	// "the bulk of the response", measured at 18% against 38% for the descriptions of rows the
	// agent cannot run. A `.describe()` on a PARAMETER lands inside `inputSchema`, which IS in the
	// fingerprint, unlike the tool's own description; this entry exists because the lock caught
	// exactly that distinction. 0.1.3 is live in the registry as `isLatest` — appended, not edited.
	"0.1.4": "sha256:7963715848df074622b41a352f96714b1c90e573466d9e56f725f7df94b36dcf",
	// 0.1.5 (#595): `vector_stats` and `my_agents` each gained `offset` and `limit`. Both were
	// measured over a calling host's 64 KiB limit in production AFTER #586's compaction —
	// 151,700 B and 66,013 B — so the collections they return are now paged, and an argument
	// added to a tool lands in `inputSchema`, which IS in the fingerprint. The result SHAPES also
	// changed (both now lead with the totals and carry a `page`), which is a consumer-visible
	// change the fingerprint cannot see: it hashes what a host is TOLD about a tool, not what the
	// tool answers. That is the same gap #561 fell through when `my_instances` became
	// `{"instances":[…]}` under a frozen version, and it is why the bump is justified twice over
	// here. Appended, never edited: 0.1.4 is published.
	"0.1.5": "sha256:cf3a8e35a95a152601e5cea1fed4bcae56b15bcffd87651d8b499a6048d72951",
	// 0.1.6 (#614): `agent_trace` gained `offset`, and `instance_board` gained `offset` and
	// `limit`. Both were measured over a calling host's 64 KiB limit in production — 163,437 B and
	// 128,692 B, the two #595 recorded as KNOWN_OVER and could not fix because their files were
	// held open — so the collections they return are now paged, and an argument added to a tool
	// lands in `inputSchema`, which IS in the fingerprint.
	//
	// `agent_trace` is the one that matters: the server's own `instructions` string tells a client
	// to "call agent_trace first" when debugging an agent, so at 2.5x the ceiling the documented
	// first step of debugging was the one call a conforming host could not make.
	//
	// Both result SHAPES also changed — each now leads with the totals it must never reduce
	// (`count`; `jobCount` + `columns`) and carries a `page`. The fingerprint cannot see that: it
	// hashes what a host is TOLD about a tool, not what the tool answers. Same gap #561 fell
	// through when `my_instances` became `{"instances":[…]}` under a frozen version, so the bump
	// is justified twice over here as it was for 0.1.5. Appended, never edited: 0.1.5 is published.
	"0.1.6": "sha256:bdf6eb2efd98c4df362bbc6762537ca8b687dc9a03ce21a519326a73c21b9e98",
	// 0.1.7 (#672): `whoami` registered — a new tool NAME in the always-on `account` group,
	// the first bullet of `MCP_SERVER_VERSION`'s list, so the served surface grew by one and
	// this hash moves. It reads the new `GET /v1/auth/me/account` and is annotated `read`
	// (`readOnlyHint: true`), matching its ungated gate. Appended, never edited: 0.1.6 is published.
	"0.1.7": "sha256:5a0bca0af76e29fa7ac6dcd673d76a8ba7a32dc9c6d506f3aa7b2e30c99eade8",
	// 0.1.8 (#674/#671): two surface changes in one bump, because they ship in one commit.
	//
	//   · `coding_timeline` gained `before`, the backward cursor. An argument lands in
	//     `inputSchema`, which IS in the fingerprint. The change that PROMPTED it is invisible to
	//     this hash and is the more consequential one: a call with no cursor now returns the NEWEST
	//     page rather than the oldest. That is a result-shape change of the kind #561 fell through
	//     under a frozen version — `has_more` still means "there is more", but in the other
	//     direction — so the bump is justified twice over here, as it was for 0.1.5 and 0.1.6.
	//   · Three tool NAMES registered in the always-on `runtime` group — `list_runner_nodes`,
	//     `instance_runner_node`, `set_instance_runner_node` — which is the first bullet of
	//     `MCP_SERVER_VERSION`'s list. 137 tools to 140, 118 always-on to 121.
	//
	// Appended, never edited in place: 0.1.7 is published.
	"0.1.8": "sha256:599bfad95dd9c388d3c10719eb91037881c8d69601784c406180d42f571331d2",
	// 0.1.9 (PAS #137): one new tool NAME in the always-on `board` group, `update_board_ticket`.
	// A board ticket could be filed and moved but never edited, so correcting one word meant
	// filing a replacement and cancelling the original, leaving a dead card behind.
	//
	// The set of registered tool names is the first bullet of server-version.ts's bump list, and
	// it is the one a caching host is most exposed to: a host holding the 0.1.8 list does not know
	// this tool exists, and unlike a widened `inputSchema` there is no degraded call it can still
	// make. Appended, never edited: 0.1.8 is published.
	"0.1.9": "sha256:48d7f82fa78bef415b3b87c61d7e9860c18f65901aec20c74f892ad23d77ff04",
	// 0.1.10 (#681): `agent_deploy_status` gained a `token` argument — the audit found it was
	// the sole GitHub-backed tool taking no token and running no `ownsAgent()` check, reaching
	// GitHub with the worker's own credential for any repo name in the org. Adding the token
	// lands in `inputSchema`, which IS in the fingerprint, so this hash moves. The paired
	// `ownsAgent()` + `requirePermission("read", …)` guards are handler internals — a change to
	// WHEN a call is refused, not WHAT is published — and do not themselves move the surface.
	// The nine `storage-tools.ts` `.describe()` additions shipped in the same change are on the
	// tools' own token params but are DESCRIPTIONS, excluded from the fingerprint on purpose.
	// (Originally authored as 0.1.8 pre-rebase; 0.1.8 and 0.1.9 landed first, so this is 0.1.10.)
	// Appended, never edited: 0.1.9 is published.
	"0.1.10": "sha256:5ad96d5d35a9dbc8a3b30a64d756789ea8838321655c8178803edb9754387b6d",
	// 0.1.11 (#696): one new tool NAME in the surface-gated `coding` group,
	// `coding_session_open`, plus a reworded `session_id` PARAMETER on `coding_session_message`
	// — a `.describe()` on an argument lands inside `inputSchema`, which IS in the fingerprint,
	// unlike a tool's own description.
	//
	// The name is the half a caching host cannot work around: #408's four-day conversation
	// continuity was reachable only from the console, because the sole MCP opener
	// (`coding_session_fresh`) hardcodes the flag that turns it off. A host holding the 0.1.10
	// list does not know the opener exists, and there is no degraded call it can make instead.
	// (Authored as 0.1.10 pre-rebase; #681 landed that number first — the same collision the
	// entry above records, and the reason this map is append-only rather than renumbered.)
	// Appended, never edited: 0.1.10 is published.
	"0.1.11": "sha256:5b9c234f3e8b6f35ee19c890c3fb1b18e9e31f523692817e3cc9f45d3a27022a",
	// 0.1.12 (#699): one new tool NAME in the surface-gated `coding` group, `coding_terminal` —
	// the first bullet of `MCP_SERVER_VERSION`'s list, so 142 registrations become 143 and 20
	// surface-gated become 21. `MCP_TOOL_ALWAYS_ON` does not move: the registration sits inside
	// the same `groups.has("coding")` gate as `coding_timeline`.
	//
	// It is the name a caching host cannot work around, and this one has no degraded substitute at
	// all: a finished run's terminal text was reachable through `?terminal=1` on a route MCP never
	// called, while the only MCP reader served a 400-character tail — 3,200 of 64,000 stored
	// characters on the session measured on 2026-08-18, i.e. 5%. A host holding the 0.1.11 list
	// does not know this tool exists and its alternatives are the tail and an empty pane.
	//
	// The two description changes that ship with it — `coding_timeline` and
	// `coding_session_capture` naming it for the finished-session case — are NOT what moved this
	// hash; descriptions are excluded from the fingerprint on purpose. Appended, never edited in
	// place: 0.1.11 is published.
	"0.1.12": "sha256:5c7324bc914e95114c5aada181c29a1c6b3effe8f85ad90ec9529c2807e3fff8",
	// 0.1.13 (#667): two new tool NAMES in the always-on `composition` group,
	// `set_supervision_enabled` and `set_connection_enabled` — the first bullet of
	// `MCP_SERVER_VERSION`'s list, so 143 registrations become 145 and 122 always-on become 124.
	// `MCP_TOOL_GATED` does not move: composition is registered ungated, like base.
	//
	// They are the pause `agent_connections.enabled` (#644) and `agent_supervision.enabled` (#664)
	// each got a writer and a `PATCH …/{id} {enabled}` route for and no tool. A host holding the
	// 0.1.12 list does not know they exist, and unlike a widened `inputSchema` there is no degraded
	// call it can make instead — the only substitute on that surface is `delete_supervision`, which
	// is the destructive act the pause exists to avoid: it throws away the subordinate's standing
	// direction, or the connection's routing filter and target pipeline, and orphans the outbox
	// rows that say what is stuck. A stale list therefore does not merely omit the tool; it leaves
	// the caller with a worse one that looks like the answer.
	//
	// Appended, never edited in place: 0.1.12 is published.
	"0.1.13": "sha256:442ab86457e43cdf6e11ecf72d7280a68f402ebaf0439607b1cb10a11a815ee2",
	// 0.1.14 (#743): a sentence added to `SERVER_INSTRUCTIONS`, which is the one non-tool input to
	// this hash and the only reason this bump exists. No tool name, `inputSchema`, annotation or
	// `outputSchema` moved.
	//
	// What it says is the routing rule this surface never carried: an instance's OWN connector
	// tools are one level down, so `list_instance_tools` + `call_instance_tool` comes BEFORE
	// `coding_session_message`. Measured 2026-08-23 — an external client asked to triage a repo's
	// issues, told its user it had "no GitHub connector", drove the owner's CLI to run
	// `gh issue list`, read a truncated pane, and advised configuring a connector that was already
	// declared, consented and callable on that instance. `grep -c "call_instance_tool\|
	// list_instance_tools"` over `platform-guide.ts` returned 0, and `SERVER_INSTRUCTIONS` named
	// neither: the pattern was undiscoverable from the two documents whose job is to describe this
	// platform to a model.
	//
	// A result SHAPE also changed, which this hash cannot see and which is therefore recorded here
	// rather than left to be found: `coding_repos_list` answers `{repos: […]}` instead of a bare
	// array, with an optional `hint` beside it. Same change `my_instances` made under a frozen
	// version in #561 — the gap 0.1.5 and 0.1.6 also had to name — so the bump is justified twice
	// over, as it was for those two.
	//
	// The description changes shipping with this (`coding_session_message` saying it is the
	// fallback) are NOT what moved the hash; descriptions are excluded from the fingerprint on
	// purpose, per DECISION 1 above. Appended, never edited in place: 0.1.13 is published.
	"0.1.14": "sha256:586017fa55be526d398c55945cedee7cff0db4ce6d6cd083ccdd940dd59d526d",
	// 0.1.15 (#716): `subscribe_agent` gained an `idempotency_key` argument — a caller-supplied
	// dedup guard that lets a retry after a lost-response error return the existing instance
	// instead of creating a duplicate. An argument added to a tool lands in `inputSchema`, which
	// IS in the fingerprint. No tool name, annotation or `outputSchema` moved.
	// Appended, never edited in place: 0.1.14 is published.
	"0.1.15": "sha256:f2a8fae67c5502cceaca8459699f5c90f92277d1b3bb1f797f5531319b107e1d",
	// 0.1.16 (#762): `upload_agent_file` gained `content_base64` — an optional standard-base64
	// argument that lets any tool or connector put binary bytes (a Word form, an image, a PDF)
	// directly into the agent file store. `content` is now optional (one of the two must be
	// provided); an argument added or made optional lands in `inputSchema`, which IS in the
	// fingerprint. No tool name, annotation, or outputSchema moved. The symmetric change to the
	// agent-DO `upload_file` tool declaration is handler-only: its `ToolDef` is consumed inside
	// the DO and not exposed through the MCP surface.
	// Appended, never edited in place: 0.1.15 is published.
	"0.1.16": "sha256:a68aca8589a0e2dae8d8bc88281afc74bd2d1426d1b53e621d3d56a8ee34677a",
	// 0.1.17 (#683): one new tool NAME in the surface-gated `coding` group,
	// `coding_instance_deploy_status` — the first bullet of `MCP_SERVER_VERSION`'s bump list.
	// 145 registrations become 146, 21 surface-gated become 22 (coding: 14 → 15).
	// `MCP_TOOL_ALWAYS_ON` does not move: this registration sits inside the same
	// `groups.has("coding")` gate as the other coding tools.
	//
	// The new tool reads GitHub Actions workflow runs for a coding instance's registered repo
	// (any `owner/repo`, not only a ProAgentStore agent repo). It is `read`-scoped and
	// uses the worker's `GITHUB_TOKEN` — same credential as `agent_deploy_status`, but
	// without assuming the repo is in the `GITHUB_ORG` org or that the workflow is `deploy.yml`.
	//
	// Appended, never edited in place: 0.1.16 is published.
	"0.1.17": "sha256:cd24991cf9659bb8f09af6b4ad3ef47b8f2d4e72352b6fffb18fc12d063d78f9",
	// 0.1.18 (#739): two new tool NAMES registered unconditionally (always-on):
	// `get_instance_operator_manual` (read) and `set_instance_operator_manual` (write).
	// 146 registrations become 148; `MCP_TOOL_ALWAYS_ON` moves 124 → 126;
	// `MCP_TOOL_GATED` (derived) stays at 22 — neither tool is surface-gated.
	//
	// These are the MCP half of the caller-facing operator manual (#739 Slice 1). The agent
	// also gets a BASE-tier `read_operator_manual` tool (not on this surface) and a bounded
	// injected notice in `agent-think.ts`, both in the same commit.
	//
	// Appended, never edited in place: 0.1.17 is published.
	"0.1.18": "sha256:ab5fcce1033ec9a84e31d42ec01915e6f72d57720b40ce2b03e04605708decc5",
	// 0.1.19 (#767): one new tool NAME in the surface-gated `coding` group,
	// `coding_loop_trace` — the run-id-addressable reader for the same coding timeline feed
	// `coding_timeline` already exposes by session. The API now accepts `run_id` on
	// `GET /v1/instances/:id/coding/timeline`, so MCP can hand a caller the live
	// timeline/tool-call/terminal-tail events for the `runId` returned by `coding_loop_start`
	// without first making it discover the session id.
	//
	// It is read-scoped and gated to `surfaces:["coding"]`; 148 registrations become 149, and
	// the surface-gated count moves 22 → 23. `MCP_TOOL_ALWAYS_ON` does not move.
	//
	// Appended, never edited in place: 0.1.18 is published.
	"0.1.19": "sha256:e1b7b7da1444269800746126ac2a3c76853e1b4756d14b60866b2cf0bae4f81b",
	// 0.1.20 (#769): SERVER_INSTRUCTIONS now tells MCP callers to read the exact
	// tools/list input schemas and copy opaque ids exactly. Runtime tools,
	// call_instance_tool and chat_with_agent parameter descriptions were strengthened
	// to prevent first-call parameter errors. Argument descriptions live in inputSchema,
	// so this is a served surface change. No tool names or counts changed.
	//
	// Appended, never edited in place: 0.1.19 is published.
	"0.1.20": "sha256:d9f550de7233837e5ae90de5b508ac67e58ad2feff5b74a90358a120c4fa5aa9",
	// 0.1.21 (#772): one new tool NAME registered unconditionally (always-on),
	// `get_instance_connection_guide` (read). 149 registrations become 150;
	// `MCP_TOOL_ALWAYS_ON` moves 126 → 127; `MCP_TOOL_GATED` (derived) stays at 23 —
	// the tool is not surface-gated, because the discovery problem it solves belongs to
	// every agent type rather than to the ones with a console surface.
	//
	// It renders the per-instance connection guide: the instance id, its agent type, its
	// registered repos, the tools it actually exposes with their exact field names, and a
	// worked `call_instance_tool` example built from a real input schema. The facts are the
	// ones `list_instance_tools` already returns — read through the SAME
	// `instanceToolPolicy` + `projectToolListing` pair `GET /v1/instances/:id/tools` uses, so
	// the guide cannot become a second answer to "what may this instance run". Nothing is
	// stored: the document is rendered per call, per #739 Decision 4.
	//
	// Appended, never edited in place: 0.1.20 is published.
	"0.1.21": "sha256:8ed85ef12e0efb94a154f4c562eaffa2350c5c7cdf193979c3320709c879efbd",
	// 0.1.22 (#783): the pinned session. No platform-wide tool name, schema or annotation
	// moved and `MCP_TOOL_COUNT` stays at 150; what moved is `SERVER_INSTRUCTIONS`, which now
	// ends with one sentence telling a caller that `/mcp/i/<instance_id>` publishes only that
	// instance's own tools (no `instance_id` argument) plus chat/guide/messages. The
	// instructions are inside the fingerprint by DECISION 1, so this is a served-surface
	// change and the version moves. The pinned surface itself is not in this hash: its names
	// are an instance's policy rows, held to their own contract in `pinned.test.ts`.
	//
	// Appended, never edited in place: 0.1.21 is published.
	"0.1.22": "sha256:0565f1ca5211d6b338a2268514c0ab56d4d761d019982473a0c384b98a3a497d",
	// 0.1.23 (#787): one new tool NAME registered unconditionally (always-on), `recent_instances`
	// (read) — the first bullet of `MCP_SERVER_VERSION`'s bump list. 150 registrations become
	// 151; `MCP_TOOL_ALWAYS_ON` moves 127 → 128; `MCP_TOOL_GATED` (derived) stays at 23.
	// `SERVER_INSTRUCTIONS` also moved: its id-first sentence now names the new tool beside
	// `my_instances`, and the instructions are inside the fingerprint by DECISION 1.
	//
	// It is the name a caching host cannot work around, and the one this ticket exists for: a
	// fresh conversation asking "what was I working on?" had only `my_instances` (the whole
	// roster, ordered by the instance's own activity) and `coding_loop_status` (one instance,
	// id required). The recency signal did not exist — read tools audit nothing — so the same
	// change records it, from the registration pipeline, which is why no `inputSchema` moved:
	// the recording is a property of the seam, not an argument on any tool.
	//
	// Appended, never edited in place: 0.1.22 is published.
	"0.1.23": "sha256:a468f949178aaa27b85a5edfcf40bf4b5dd637ec74c6f3ad94f165dac7da6890",
	// 0.1.24 (#788): queued follow-up objectives. THREE things a client receives moved, and all
	// three are the first bullets of `MCP_SERVER_VERSION`'s own list:
	//
	//   * two new tool NAMES, both always-on beside `coding_loop_start` rather than surface-gated
	//     (the Agent Loop tools have never been gated — the queue belongs to the same verb):
	//     `coding_loop_queue` (read) and `coding_loop_queue_cancel` (write). 151 registrations
	//     become 153; `MCP_TOOL_ALWAYS_ON` moves 128 → 130; `MCP_TOOL_GATED` (derived) stays at 23.
	//   * an `inputSchema` change on `coding_loop_start`: the `queue_if_busy` argument, which turns
	//     a busy repo from an outright refusal into a queued objective the platform starts when the
	//     active run reaches a terminal state.
	//   * the annotations for the two new names, from `tool-metadata.ts`.
	//
	// `SERVER_INSTRUCTIONS` did NOT move. The queue is reached through `coding_loop_start`, which
	// the instructions already name, and adding a sentence for every tool is how that string stops
	// being read.
	//
	// Appended, never edited in place: 0.1.23 is published.
	"0.1.24": "sha256:8c3f4657df1d24196df6b1fc937e95babd811c42fac0911c3c346262ca3f7960",
	// 0.1.25 (#692): one new tool NAME, `coding_repo_remove` — the first bullet of
	// `MCP_SERVER_VERSION`'s bump list. SURFACE-GATED, not always-on: it lives in
	// `coding-tools.ts` behind `groups.has("coding")` beside `coding_repo_add`, so 153
	// registrations become 154, `MCP_TOOL_GATED` (derived) moves 23 → 24, and
	// `MCP_TOOL_ALWAYS_ON` stays at 130.
	//
	// It closes an asymmetry rather than adding a capability: the surface could ATTACH a repo to a
	// coding instance (`coding_repo_add`) and had no way to detach one, so a binding created by
	// automation could only be removed by a human in the console. The endpoint it calls,
	// `DELETE /v1/instances/:id/coding/repos/:repoId`, has existed all along — its only caller was
	// `agents/coder/web`, which is why the MCP parity guard never saw the gap (that guard inventories
	// `store/console/src`).
	//
	// Annotated `destructive` (`destructiveHint: true`), with a `confirm` string and a `dry_run`,
	// because removing the binding asks the runner to end any active engine on that repo.
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.24 is published.
	"0.1.25": "sha256:ec2538db46e034243a5f9b0474d7c99e55e14680b30beaa7910044dd25a0ef89",
	// 0.1.26 (#804): an `inputSchema` change on `coding_loop_start`, and no new name — 154
	// registrations, `MCP_TOOL_ALWAYS_ON` 130, `MCP_TOOL_GATED` 24, all unchanged.
	//
	//   * `repair_checkout` (boolean, optional): start a REPAIR run — the sync gate (#801) lets it
	//     through, the platform writes its objective (get onto the branch, in sync with upstream,
	//     clean tree, nothing deleted), and it may do no other work. It is the way out of a block
	//     that needs no hands on the machine, and every block message for a behind/diverged
	//     checkout now ends by naming it.
	//   * `objective` becomes OPTIONAL in the schema, because a repair run's objective is the
	//     platform's. The handler still refuses a work run without one; the schema cannot say
	//     "required unless", so the `.describe()` does.
	//
	// `SERVER_INSTRUCTIONS` did NOT move: the flag is reached through `coding_loop_start`, which
	// the instructions already name.
	//
	// Appended, never edited in place: 0.1.25 is published.
	"0.1.26": "sha256:6bf384ce80d5a273d0ba907e65169d5b7e5a4aaaafb389ad35ca6b62b6dab083",
	// 0.1.27 (#774): `SERVER_INSTRUCTIONS` only — the last bullet of `MCP_SERVER_VERSION`'s bump list.
	// No tool name, schema or annotation moved: 154 registrations, `MCP_TOOL_ALWAYS_ON` 130,
	// `MCP_TOOL_GATED` 24, all unchanged.
	//
	// Two sentences after the #743 one (both from `instance-tool-guidance.ts`, which `PLATFORM_GUIDE`
	// also renders):
	//   * NESTED_TOOL_SEQUENCE — `list_instance_tools` with `schemas:true`, then `call_instance_tool`
	//     with the field names that schema declares, only for a row whose `invocableBy` lists it.
	//     #743 named the pattern; an orchestrator still guessed `issue_number` for `number`.
	//   * DIRECT_BEFORE_RUN — a job needing no code change is one such call, not a `coding_loop_start`.
	//
	// `my_instances` still sits in the first sentence, inside the 512-character cut.
	//
	// Appended, never edited in place: 0.1.26 is published.
	"0.1.27": "sha256:17fa7a94d3f9fbfb33177a8d02f1c1a89b8187abc4428d7f841ab61c91f3787d",
	// 0.1.28 (#613, the notifications and account-preferences group): five new tool NAMES, all
	// ALWAYS-ON in `instance-tools/account.ts` — 154 registrations become 159, `MCP_TOOL_ALWAYS_ON`
	// 130 → 135, `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_notifications` (read) — GET /v1/notifications, `unread_only` + `limit`.
	//   * `mark_notification_read` (write, dry_run) — POST /v1/notifications/:id/read. The route now
	//     answers 404 for an id that matched nothing instead of `{success:true}`.
	//   * `mark_all_notifications_read` (write, dry_run) — POST /v1/notifications/read-all.
	//   * `get_account_preferences` (read) — GET /v1/preferences.
	//   * `set_account_preferences` (write, dry_run) — PUT /v1/preferences, sending only the sections
	//     supplied: `timezone`, `notifications`, `voice`, `translation`.
	//
	// Closes that group's `KNOWN_GAPS` entry (5 routes; parity 85 → 90 reachable, 71 → 66 gaps).
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.27 is published.
	"0.1.28": "sha256:5104784d5f734fd2efb24f0bbe701d60ef2c4999213adb4faa0d916cb57ecaea",
	// 0.1.29 (#613, the knowledge-writes group): three new tool NAMES, all ALWAYS-ON — 159
	// registrations become 162, `MCP_TOOL_ALWAYS_ON` 135 → 138, `MCP_TOOL_GATED` stays 24.
	//
	//   * `update_instance_knowledge` (write, dry_run) — PUT /v1/instances/:id/knowledge/:docId in
	//     `instance-tools/knowledge.ts`; sends only `title` / `content` as supplied, keeps the id.
	//   * `ingest_instance_knowledge_url` (write, dry_run) — POST /v1/instances/:id/knowledge/ingest-url
	//     in the same file; the DO fetches (SSRF-guarded), the dry run fetches nothing.
	//   * `update_instance_record` (write, dry_run) — PUT /v1/instances/:id/collections/:name/records/:id
	//     in `storage-tools.ts`, beside `insert_instance_record`; `data` is merged, never a replace.
	//
	// Closes that group's `KNOWN_GAPS` entry (3 routes; parity 90 → 93 reachable, 66 → 63 gaps).
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.28 is published.
	"0.1.29": "sha256:471c265d4651b476b45ffaf857c92dfe18eaaf8209bf83e1d044515ab77f0944",
	// 0.1.30 (#613, the loop-presets group): two new tool NAMES, both ALWAYS-ON — 162
	// registrations become 164, `MCP_TOOL_ALWAYS_ON` 138 → 140, `MCP_TOOL_GATED` stays 24.
	//
	//   * `get_instance_loop_presets` (read) — GET /v1/instances/:id/loop-presets in
	//     `instance-tools/composition.ts`, beside `start_instance_loop`.
	//   * `set_instance_loop_presets` (write, dry_run) — PUT to the same route; replaces the list,
	//     `[]` clears the instance's own; a list the route would trim or drop is refused first.
	//
	// Closes that group's `KNOWN_GAPS` entry (2 routes; parity 93 → 95 reachable, 63 → 61 gaps).
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.29 is published.
	"0.1.30": "sha256:47d1cafcfb5baa6e3377e75fd43cb31c30352d58ec98becb4d1a89a712389a18",
	// 0.1.31 (#613, the product-feedback group): two new tool NAMES, both ALWAYS-ON — 164
	// registrations become 166, `MCP_TOOL_ALWAYS_ON` 140 → 142, `MCP_TOOL_GATED` stays 24.
	//
	//   * `record_instance_feedback` (write, dry_run) — POST /v1/feedback in
	//     `instance-tools/observability.ts`, beside `list_feedback`; `author: "user"` under a
	//     description requiring the owner's words, every row stamped `context.via = "mcp"`.
	//   * `delete_feedback` (destructive, dry_run + confirm) — DELETE /v1/feedback/:id.
	//
	// Closes that group's `KNOWN_GAPS` entry (2 routes; parity 95 → 97 reachable, 61 → 59 gaps),
	// and with it the entry's stale claim that `list_feedback` did not exist.
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.30 is published.
	"0.1.31": "sha256:e38a1fa93e8eb15e4c1b010692e6166c5cd9d505102076b05f4b3f0c43c9823e",
	// 0.1.32 (#736 item b, which account an instance uses): two new tool NAMES, both ALWAYS-ON —
	// 166 registrations become 168, `MCP_TOOL_ALWAYS_ON` 142 → 144, `MCP_TOOL_GATED` stays 24.
	//
	//   * `get_instance_connector_account` (read) — GET /v1/instances/:id/connector-accounts in
	//     `instance-tools/connectors.ts`, optionally narrowed to one connector.
	//   * `set_instance_connector_account` (write, dry_run) — PUT to the same route; refuses a blank
	//     `account_id` (the route reads it as clear) and answers with the connector's row read back.
	//
	// Closes that route's `KNOWN_GAPS` entry. `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.31 is published.
	"0.1.32": "sha256:b025eca1789666c42c0b2f002b548a0cb511c14b1f8edbb775324af7fe19bddd",
	// 0.1.33 (#613, the voice-settings group): three new tool NAMES, all ALWAYS-ON — 168
	// registrations become 171, `MCP_TOOL_ALWAYS_ON` 144 → 147, `MCP_TOOL_GATED` stays 24.
	//
	//   * `get_instance_voice_settings` (read) — GET /v1/instances/:id/voice-settings in
	//     `instance-tools/settings.ts`, beside `get_translation_config`; returns the RESOLVED
	//     block plus `hasOverride`, not the stored override.
	//   * `set_instance_voice_settings` (write, dry_run) — PUT to the same route. It READS first
	//     and sends the current settings back merged, because that PUT is not a patch: the route
	//     sanitizes the body against `overrideVoiceBase`, which supplies the ACCOUNT value for
	//     every unnamed field, so a bare patch would reset the rest of the agent's override.
	//     `vocabulary` is deliberately NOT echoed — it unions across scopes (#373), so echoing
	//     the resolved value would snapshot the account's words into this agent permanently.
	//   * `clear_instance_voice_settings` (write, dry_run) — DELETE to the same route: the
	//     console's "Use my defaults". The account preferences underneath are untouched.
	//
	// Closes that group's `KNOWN_GAPS` entry (3 routes; parity 99 → 102 reachable, 57 → 54 gaps).
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.32 is published.
	"0.1.33": "sha256:f679765019a0f34a55c9a8d0234f58d055eb7700b459b1c636ac4200c4d8ca96",
	// 0.1.34 (#613, a run's detail view and its handoffs): seven new tool NAMES, all ALWAYS-ON —
	// 171 registrations become 178, `MCP_TOOL_ALWAYS_ON` 147 → 154, `MCP_TOOL_GATED` stays 24.
	// All seven are in `instance-tools/runtime.ts`, which is where the `runtime` scope lives.
	//
	//   * `get_instance_task` (read) — GET /v1/instances/:id/tasks/:taskId.
	//   * `delete_instance_task` (destructive, dry_run + confirm) — DELETE the same route.
	//   * `answer_instance_input` (runtime, dry_run) — POST /v1/instances/:id/input, the
	//     needs_input handoff; the route reads `taskId`, not `task_id`.
	//   * `resume_instance_takeover` / `end_instance_takeover` (runtime, dry_run) — POST
	//     /v1/instances/:id/takeover/:taskId/{resume,end}.
	//   * `send_instance_takeover_input` (runtime, dry_run) — POST …/takeover/:taskId/input, one
	//     CDP mouse/key event, aimed by page pixel coordinate.
	//   * `start_instance_browser_task` (destructive annotation, dry_run) — POST
	//     /v1/instances/:id/browse. `commit` is the INVERSE of the route's `dryRun`, and gates the
	//     scope per call: a rehearsal is `runtime`, a run allowed to commit is `destructive` —
	//     the same split `apply_to_job` makes with `submit`.
	//
	// Closes that group's `KNOWN_GAPS` entry. The eighth route in the group,
	// `POST /tasks/:taskId/resume`, was NOT wrapped: the API has never registered it, and the
	// console called it only as a dead `.catch` fallback — removed in the same commit, so the
	// capability leaves the inventory rather than becoming an exclusion for a route that does
	// not exist. Parity 99 → 109 reachable of 166 (the denominator drops with it), 57 → 46 gaps.
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.33 is published.
	"0.1.34": "sha256:081d4b4b6b475b00c1736f3107e434bdce6aab2cd6b7e3984de2257aa4fba79b",
	// 0.1.35 (#613, trigger and connector metadata): five new tool NAMES, all ALWAYS-ON — 178
	// registrations become 183, `MCP_TOOL_ALWAYS_ON` 154 → 159, `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_connectors` (read) — GET /v1/connectors, the account-level catalogue.
	//   * `list_instance_connectors` (read) — GET /v1/instances/:id/connectors, this agent's
	//     verdict on each, carrying the same refusal sentence the grant routes use.
	//   * `set_instance_connector_consent` (write, dry_run) — PUT …/connectors/:connector/consent.
	//     All three in `instance-tools/connectors.ts`.
	//   * `list_trigger_actions` (read) — GET /v1/triggers/actions, which REQUIRES `instanceId`.
	//   * `preview_instance_trigger` (read) — POST /v1/triggers/preview. Annotated read although
	//     the route is a POST: the verb carries a draft config and the route computes without
	//     writing. Both in `instance-tools/triggers.ts`, beside `create_instance_trigger`, which
	//     was the blind write this pair exists to stop being necessary.
	//
	// Closes that group's `KNOWN_GAPS` entry (5 routes; parity 109 → 114 reachable of 166,
	// 46 → 41 gaps across 8 groups). `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.34 is published.
	"0.1.35": "sha256:4bb1e1d1782c17dfaf23d2232084330a771440ac356a899976ca87d4fd62963c",
	// 0.1.36 (#613, outbound MCP connections — PAGS as an MCP CLIENT): six new tool NAMES, all
	// ALWAYS-ON, in a NEW registrar `instance-tools/mcp-connections.ts` (group `mcpConnections`
	// in the contract table) — 183 registrations become 189, `MCP_TOOL_ALWAYS_ON` 159 → 165,
	// `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_mcp_presets` (read) — GET /v1/mcp/presets.
	//   * `list_instance_mcp_grants` (read) — GET /v1/instances/:id/mcp/consent.
	//   * `set_instance_mcp_grant` (write, dry_run) — PUT the same route; one (endpoint, tool)
	//     pair, and granting also switches on the connector-level MCP write consent, as the route
	//     does for the console.
	//   * `test_instance_mcp_server` (runtime, dry_run) — POST /v1/instances/:id/mcp/test.
	//   * `list_instance_mcp_input_requests` (read) — GET …/mcp/input-requests.
	//   * `answer_instance_mcp_input_request` (runtime, dry_run) — POST …/mcp/input-requests/:id.
	//
	// The last two are `runtime` and not `write` because each reaches a THIRD PARTY: the test
	// contacts the endpoint, and answering retries the paused remote call with the owner's
	// values. `runtime` is the scope that means "this spends or drives something outside the
	// platform", and neither belongs in a read-only session.
	//
	// SIX tools for a five-route group: the sixth, POST …/mcp/input-requests/:requestId, is the
	// ANSWER half of the elicitation loop the group's own description names. It is missing from
	// the parity inventory because `scripts/lib/api-calls.mjs` silently drops the console's
	// multi-line call shape (verified against McpInputRequests.tsx:78) — a measurement defect
	// recorded on #613, not a reason to ship a tool that can list a paused ask and never resolve it.
	//
	// Closes that group's `KNOWN_GAPS` entry (5 routes; parity 114 → 119 reachable of 166,
	// 41 → 36 gaps across 7 groups). `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.35 is published.
	"0.1.36": "sha256:c61a8ba0de559e33f7097df56d3a743d51c30500aaf060f6737e37c70ad1c618",
	// 0.1.37 (#613, teamwork plumbing — the pump's FAILURE path): three new tool NAMES, all
	// ALWAYS-ON, in `instance-tools/composition.ts` beside the connection family they complete —
	// 189 registrations become 192, `MCP_TOOL_ALWAYS_ON` 165 → 168, `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_connection_deliveries` (read) — GET /v1/instances/:id/connections/deliveries.
	//     Account-wide, filterable by `status`; the rows are the only trace a broken chain leaves.
	//   * `replay_connection_delivery` (runtime, dry_run) — POST …/deliveries/:did/replay.
	//     `runtime`, not `write`: re-arming makes the CONSUMER run.
	//   * `delete_connection` (destructive, dry_run + confirm) — DELETE …/connections/:cid. The
	//     reversible form of the same intent is `set_connection_enabled`, which stays `write`.
	//
	// Closes that group's `KNOWN_GAPS` entry. The group's fourth route,
	// `GET …/supervision/:sid/direction`, was NEVER REAL: `scripts/lib/api-calls.mjs` defaulted an
	// unreadable `method:` to GET, so the console's `method: text === null ? "DELETE" : "PUT"`
	// was recorded as a GET against a route the API does not serve. The extractor now declines to
	// measure a computed method instead of inventing one, and writing a supervisor's DIRECTION is
	// recorded in `EXCLUSIONS` as a statement — that route is the only path that stamps
	// `setBy:"user"`, which is the boundary that keeps one prompt injection from becoming a
	// standing instruction. Parity 119 → 122 reachable of 165 (the denominator drops with the
	// phantom), 41 → 32 gaps across 6 groups.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.36 is published.
	"0.1.37": "sha256:0a54ea7c44d237315a96cc05a124715bc415182478340b66d849a553d1baf13f",
	// 0.1.38 (#613, standing agent tasks): four new tool NAMES, all ALWAYS-ON, in a NEW registrar
	// `instance-tools/agent-tasks.ts` (group `agentTasks`) — 192 registrations become 196,
	// `MCP_TOOL_ALWAYS_ON` 168 → 172, `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_agent_tasks` (read) — GET /v1/instances/:id/agent-tasks, with the store's
	//     `limits` (max, injected-per-prompt, staleDays).
	//   * `create_agent_task` (write, dry_run) — POST the same route.
	//   * `update_agent_task` (write, dry_run) — PUT …/agent-tasks/:taskId, named fields only.
	//   * `delete_agent_task` (destructive, dry_run + confirm) — DELETE the same route.
	//
	// A SEPARATE registrar from `board.ts` on purpose: `/agent-tasks` is not `/tasks`, and the
	// API paid for that distinction in its route naming. A board ticket is a unit of work a
	// runner finishes; a task here is a standing instruction rendered into the prompt every
	// turn. Keeping them in one group would put `delete_agent_task` and `delete_instance_task`
	// side by side in the contract table as if they were variants of one thing.
	//
	// FOUR tools for a three-route group: the read is missing from the parity inventory, not
	// from the console — `scripts/lib/api-calls.mjs` still drops a call whose path sits on its
	// own line (TasksSection.tsx:45), the defect reported on the voice-settings and outbound-MCP
	// groups. Shipping create/update/delete without the list would have meant editing tasks
	// whose ids nothing could read.
	//
	// Closes that group's `KNOWN_GAPS` entry (3 routes; parity 122 → 125 reachable of 165,
	// 32 → 29 gaps across 5 groups). `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.37 is published.
	"0.1.38": "sha256:f774e627cf44e400a8e56348ac77296fb5099bcb45fd3f671f8742d7f7e29956",
	// 0.1.39 (#806, continue a stopped run): one new tool NAME, ALWAYS-ON — 196 registrations
	// become 197, `MCP_TOOL_ALWAYS_ON` 172 → 173, `MCP_TOOL_GATED` stays 24.
	//
	//   * `continue_instance_run` (annotated `runtime`, asserts `write`, dry_run) — POST
	//     /v1/instances/:id/loop/:runId/continue in `instance-tools/composition.ts`, beside
	//     `start_instance_loop`, whose two classes split the same way for the same reason: the
	//     annotation says this spends something out there, the gate is the one a default grant
	//     holds. A caller able to START a run must be able to continue one, or the narrower scope
	//     would be a distinction the route itself does not make.
	//
	// NOT part of #613's parity sweep: the route is new in the same change, and shipping the
	// console button without the tool would have ADDED a gap to the ratchet #613 is driving to
	// zero.
	//
	// The `dry_run` preview names the SPEND twice over, because the word "continue" invites the
	// wrong model: this opens a NEW budget and does not reanimate the stopped run's.
	// `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.38 is published.
	"0.1.39": "sha256:aa427b83ad091801d567616620814e37f95b9be48dde4a6f19f459c138113360",
	// 0.1.40 (#820, per-instance iteration bounds): two new tool NAMES, both ALWAYS-ON — 197
	// registrations become 199, `MCP_TOOL_ALWAYS_ON` 173 → 175, `MCP_TOOL_GATED` stays 24.
	//
	//   * `get_instance_loop_limits` (read) — GET /v1/instances/:id/loop-limits in
	//     `instance-tools/composition.ts`, beside the loop presets pair. Answers with the account
	//     ceiling alongside the bounds, because a floor cannot be judged without it.
	//   * `set_instance_loop_limits` (write, dry_run) — PUT to the same route; omitting both bounds
	//     clears the configuration, and an inverted pair is refused here rather than repaired,
	//     since the route is total by design and would answer 200 for bounds it had normalised.
	//
	// NOT part of #613's parity sweep: the route is new in the same change, so shipping the bounds
	// without the tools would have ADDED a gap to the ratchet #613 is driving to zero.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.39 is published.
	"0.1.40": "sha256:287bc6f14e3720b6882012337e9a907a77165df9ae01c335a38edd12a210f00a",
	// 0.1.41 (#613, the file-connector group): three new tool NAMES, all ALWAYS-ON — 199
	// registrations become 202, `MCP_TOOL_ALWAYS_ON` 175 → 178, `MCP_TOOL_GATED` stays 24.
	//
	//   * `list_instance_drive_files` (read) — GET /v1/drive/instances/:id/files in
	//     `instance-tools/connectors.ts`, beside the grant tools whose `grant_id` it requires.
	//   * `import_instance_drive_file` (write, dry_run) — POST /v1/drive/instances/:id/import.
	//   * `import_instance_workdrive_file` (write, dry_run) — POST /v1/workdrive/instances/:id/import.
	//
	// THREE tools and not one switching on `provider`, unlike every other tool in that file. The
	// two import routes are not symmetrical — Drive takes `fileId` and answers `driveFile`/
	// `webViewLink`, WorkDrive takes `resourceId` and answers `workdriveFile`/`permalink` — so a
	// single tool would have to silently re-key the caller's file argument, and sending Drive's
	// key to WorkDrive is a 400 the caller cannot see coming. Browsing is asymmetrical too:
	// WorkDrive's folder listing is a different route that is ALREADY reachable, which is why
	// only Drive gets a list tool.
	//
	// Closes that group's `KNOWN_GAPS` entry (3 routes; parity 126 → 129 reachable of 166,
	// 29 → 26 gaps across 4 groups). `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.40 is published.
	"0.1.41": "sha256:f13c4e1be1626575c4a83a5bc3f624d2db0a3b55801a919b5882057c5016124a",
	// 0.1.42 (#815 slice 1): one new tool NAME, ALWAYS-ON — 202 registrations become 203,
	// `MCP_TOOL_ALWAYS_ON` 178 → 179, `MCP_TOOL_GATED` stays 24.
	//
	//   * `account_activity` (read) — GET /v1/instances/my/activity in `instance-tools/recent.ts`,
	//     beside `recent_instances`. The whole account's health in TWO queries, where its
	//     neighbour fans out one `/loop` per instance and is capped for it.
	//
	// NOT `instance_activity`: that name belongs to the per-instance append-only LOG in
	// `observability.ts`, a different question about a different scope. The collision was caught by
	// the compiler rather than by review, which is the argument for the duplicate-key table.
	//
	// Shipped WITH the route in one commit, deliberately: a console-reachable route with no tool
	// would have forced the first NEW `KNOWN_GAPS` entry since #613 began driving that list to
	// zero. `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.41 is published.
	"0.1.42": "sha256:8f14999af7cea973bcb13f56ce403df7e767d72f1825e33291670ec958881532",
	// 0.1.43 (#823 slice 1): one new tool NAME, ALWAYS-ON — 203 registrations become 204,
	// `MCP_TOOL_ALWAYS_ON` 179 → 180, `MCP_TOOL_GATED` stays 24.
	//
	//   * `error_summary` (read) — GET /v1/errors/summary in `instance-tools/observability.ts`,
	//     beside `list_errors`. The same rows GROUPED by signature, because the write-side
	//     collapse bucket is capped at one hour: a warning firing for three days is ~72 rows in
	//     the flat feed and reads as 72 fresh incidents.
	//
	// Shipped WITH the route and the console page in one commit, for the reason 0.1.42 gives: a
	// console-reachable route with no tool would open a new `KNOWN_GAPS` entry against a list
	// #613 is driving to zero. `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.42 is published.
	"0.1.43": "sha256:e236f2744b3526d5de51d722be80e8f319a619730419d90c4cbb46b9f0f006dc",
	// 0.1.44 (#823 slices 2+3): NO new tool — 204 registrations, `MCP_TOOL_ALWAYS_ON` 180 and
	// `MCP_TOOL_GATED` 24 all unchanged. One INPUT SCHEMA moved, which is a surface change even
	// though the tool list did not:
	//
	//   * `error_summary` gains `instance_id` — one agent's failures. The instance rides in the
	//     error's free-form `context` rather than a column, so the filter matches either retained
	//     sample and is a LOWER BOUND; the description says so, because a filter that silently
	//     under-reports is worse than none.
	//
	// The same read also gained a `facets` object per signature (instances, repos, failureClasses,
	// resumed/ended). That is a RESULT shape, not an inputSchema or an outputSchema, so it does not
	// enter the fingerprint — recorded here because a reader comparing the two versions will see it
	// in the diff and should not conclude the hash missed it.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.43 is published.
	"0.1.44": "sha256:326b6f2ffec617d137b56aff521c8dbe3811fa260634561251f45f2722593804",
	// 0.1.45 (#806 item 2, review before you continue): one new tool NAME, ALWAYS-ON — 204
	// registrations become 205, `MCP_TOOL_ALWAYS_ON` 180 → 181, `MCP_TOOL_GATED` stays 24.
	//
	//   * `preview_instance_run_continue` (READ, no dry_run) — GET
	//     /v1/instances/:id/loop/:runId/continue-preview in `instance-tools/composition.ts`, beside
	//     `continue_instance_run`. It answers what a continue would CARRY FORWARD, which is not the
	//     question that tool's `dry_run` answers ("would this be refused, and how big would it be").
	//
	// `read` and not `runtime`, even though it sits beside a tool annotated `runtime`: it starts
	// nothing and opens no budget, and classing a review surface with the action it describes would
	// make reading before acting cost the scope of acting.
	//
	// Shipped WITH the route and the console disclosure in one commit, for the reason 0.1.42 and
	// 0.1.43 give: a console-reachable route with no tool opens a new `KNOWN_GAPS` entry against a
	// list #613 is driving to zero. `SERVER_INSTRUCTIONS` did not move.
	//
	// Appended, never edited in place: 0.1.44 is published.
	"0.1.45": "sha256:f73a9644daba4819571a19cd2c8d6e2fe8c91cda392f1b9dd1750925f9561f61",
	// 0.1.46 (#613, agent-template authoring — the READ half): six new tool NAMES, ALL ALWAYS-ON —
	// 205 registrations become 211, `MCP_TOOL_ALWAYS_ON` 181 → 187, `MCP_TOOL_GATED` stays 24.
	// New registrar `instance-tools/agent-authoring.ts`, so `contract.test.ts` gains the group
	// `agentAuthoring`.
	//
	//   * `my_agent` (read) — GET /v1/agents/:id WITH the owner's bearer.
	//   * `get_agent_capabilities` (read) — GET /v1/agents/:id/capabilities.
	//   * `get_agent_state` (read) — GET /v1/agents/:id/state.
	//   * `get_agent_memory` (read) — GET /v1/agents/:id/memory.
	//   * `agent_messages` (read) — GET /v1/agents/:id/messages, with `limit`/`before`.
	//   * `export_agent` (read) — GET /v1/agents/:id/export.
	//
	// The one worth reading twice is `my_agent`. `agent_info` calls `/v1/public/agents/:id`, the
	// CATALOGUE projection, so before this a creator's own DRAFT did not exist over MCP — the tool
	// 404d it exactly as it does for a stranger — and `visibility`, `status`, `cron_schedule` and
	// `owner_id` were unreachable even on a published agent. That is a wrong answer rather than a
	// missing one, which is why this half of the group went first.
	//
	// All six are READS and none is gated beyond auth: every route refuses a non-owner server-side.
	// `/:id` is the exception and degrades to the published view rather than refusing, because it
	// must still answer an anonymous caller — said in the tool's own description.
	//
	// The WRITE half of the group (delete, versions/rollback, PUT state + capabilities, chat,
	// agent-builder) is deliberately NOT here: it needs `confirm` gates and a dry-run story, and
	// mixing it in would have put a destructive surface behind a slice justified as read-only.
	//
	// `agent_info`'s DESCRIPTION was reworded to point at `my_agent`. Descriptions are excluded
	// from this fingerprint, so that change does not move the hash — recorded here because a reader
	// comparing the two versions will see it in the diff and should not conclude the hash missed it.
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.45 is published.
	"0.1.46": "sha256:fef569e0acd5e38b5c960555685aaddf4041c03ea04d771d5754cadafaac620d",
	// 0.1.47 (#825, pause/resume an instance): two new tool NAMES, both ALWAYS-ON — 211
	// registrations become 213, `MCP_TOOL_ALWAYS_ON` 187 → 189, `MCP_TOOL_GATED` stays 24. Both in
	// `instance-tools/base.ts`, the lifecycle group, registered BEFORE `cancel_instance` so a reader
	// meeting the destructive control has already met the reversible one.
	//
	//   * `pause_instance` (write, dry_run) — POST /v1/instances/:id/pause.
	//   * `resume_instance` (write, dry_run) — POST /v1/instances/:id/resume.
	//
	// `write`, NOT `destructive`, and the reasoning is `set_instance_connector_consent`'s: nothing is
	// deleted and nothing is unsubscribed, and classing the OFF switch as destructive would put
	// RESUME behind a scope the caller may not hold — the wrong failure mode for a safety toggle.
	// Not `read` either; switching an agent off is a real change. The closest existing analogues are
	// `stop_instance_loop` and `set_connection_enabled`, both `write`.
	//
	// `agent_instances.status = 'paused'` had been in the schema's declared domain since
	// 0002_instances.sql with NO writer, recorded in `lib/status-domain.ts` as a missing capability
	// rather than dead vocabulary. Its entry named the four pieces required together — a writer, a
	// resume path, a console control and the run-admission gate — and that table now marks the value
	// `app`, which is what forced all four to land in one change.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.46 is published.
	"0.1.47": "sha256:6a87a86a34668cbb16c1ae7469c7b1a90159bbd0e36e393e0b5a018ce7c60edd",
	// 0.1.48 (#806, a continue carries the owner's note): no new tool NAME — 213 registrations,
	// 189 always-on and 24 gated all stand. One inputSchema moved:
	//
	//   * `continue_instance_run` gains optional `note` — what the owner knows now that the stopped
	//     run did not. The API appends it to the new run's objective (labelled as the owner's later
	//     addition) rather than delivering it as a one-round hint, so it holds for the whole run and
	//     a further continue inherits it. Optional, so every existing caller is unaffected.
	//
	// `preview_instance_run_continue`'s RESULT gains `briefing.learned` (the stopped Pilot's own
	// notes, #822). It declares no outputSchema, so that is not part of this fingerprint — recorded
	// here because it is the half of this change a caller will actually notice. Both tools'
	// DESCRIPTIONS were reworded for it; descriptions are excluded from the hash.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.47 is published.
	"0.1.48": "sha256:db11b200d9aed39745d4ce5754f23b4de0c1d07bd4628010082d3d7f8984f33e",
	// 0.1.49 (#792, choose the coding engine and model): two new tool NAMES, both GATED to the
	// `coding` surface — 213 registrations become 215, `MCP_TOOL_GATED` 24 → 26, always-on stays 189.
	//
	//   * `coding_engine_get` (read) — GET /v1/instances/:id/coding/engine-choice.
	//   * `coding_engine_set` (write, dry_run) — PUT the same route.
	//
	// `write`, not `runtime`: the set starts nothing and spends nothing. It edits which command the
	// NEXT session launches — `defaultEngineId`, and the model as `--model` in the preset's own
	// command — which is the state the console's CLI engines panel already writes. No new setting,
	// for the reason migration 0126 records.
	//
	// One existing inputSchema moved with them: `coding_session_fresh.engine_id` no longer describes
	// itself as "(default: claude)", because it no longer is — the handler sent that constant, so the
	// one tool that starts an engine clean ignored the engine the owner had just chosen (#549's
	// defect, surviving one tool over). Omitted now means the instance's own default.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.48 is published.
	"0.1.49": "sha256:b5008db008bf75cf5b6299e9621ef7cf23ab2a12557fc69be9fe7c7f11c0138d",
	// 0.1.50 (#826, hide paused instances from default listings): no new tool. One inputSchema
	// moved — `my_instances` gains an optional `include_paused` boolean, because
	// GET /v1/instances/my/instances now omits paused instances unless asked. Tool resolution
	// (`findInstanceForAgent`, `recent_instances`, the surface gating in `userGroups`) always asks,
	// so a paused instance stays reachable by id/slug and resume_instance keeps working.
	//
	// `SERVER_INSTRUCTIONS` did not move. Appended, never edited in place: 0.1.49 is published.
	"0.1.50": "sha256:3ace939ed575e1cad8d556937cd77c1691fb228143a8b7eecba37b20c4a140fc",
};
