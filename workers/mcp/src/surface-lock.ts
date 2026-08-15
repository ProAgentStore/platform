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
};
