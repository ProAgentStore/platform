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
};
