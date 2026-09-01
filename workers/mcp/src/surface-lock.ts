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
};
