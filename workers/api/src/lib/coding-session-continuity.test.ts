import { describe, expect, it } from "vitest";
import { IDLE_SESSION_MS } from "./coding-session-sweeper.js";
import { RESUME_WINDOW_MS, resolveSessionContinuity } from "./coding-session-continuity.js";

// The boundary #408 asked for, pinned as a fact. Every case here is a sentence a user will read
// on the turn a session opens, so a change that flips one of them changes what the product claims
// to remember.

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const prev = (over: Partial<Parameters<typeof resolveSessionContinuity>[0]["previous"] & object> = {}) => ({
	id: "csess_old",
	clientType: "claude",
	status: "ended",
	lastActivityAt: NOW - 60_000,
	...over,
});

describe("resolveSessionContinuity — resume or start clean (#408)", () => {
	it("continues a conversation touched within the window, and names the id to resume from", () => {
		const r = resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: NOW - 2 * 24 * 3_600_000 }), now: NOW });
		expect(r.mode).toBe("resume");
		expect(r.resumeFrom).toBe("csess_old");
	});

	it("starts clean past the window and says how old the conversation was", () => {
		const r = resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: NOW - RESUME_WINDOW_MS - 60_000 }), now: NOW });
		expect(r.mode).toBe("fresh");
		expect(r.resumeFrom).toBeNull();
		expect(r.reason).toMatch(/4 days ago/);
	});

	it("never hands back a resumeFrom on a fresh decision", () => {
		// The one structural guarantee: a caller cannot ask the runner to resume something the
		// policy refused, because the id it would need is not in the answer.
		const decisions = [
			resolveSessionContinuity({ engine: "claude", previous: null, now: NOW }),
			resolveSessionContinuity({ engine: "codex", previous: prev(), now: NOW }),
			resolveSessionContinuity({ engine: "claude", previous: prev({ status: "error" }), now: NOW }),
			resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: null }), now: NOW }),
			resolveSessionContinuity({ engine: "claude", previous: prev({ clientType: "codex" }), now: NOW }),
		];
		for (const d of decisions) {
			expect(d.mode).toBe("fresh");
			expect(d.resumeFrom).toBeNull();
			expect(d.reason.length).toBeGreaterThan(10);
		}
	});

	it("does not resume a raw engine, whichever way round the mismatch is", () => {
		// `--resume` is a Claude Code flag and `buildClaudeArgs` is only reached in stream-json
		// mode, so a resume key handed to a codex/grok session is silently inert. Deciding "resume"
		// for one would make the notice claim a continuity the engine cannot have.
		expect(resolveSessionContinuity({ engine: "codex", previous: prev({ clientType: "codex" }), now: NOW }).mode).toBe("fresh");
		expect(resolveSessionContinuity({ engine: "claude", previous: prev({ clientType: "grok" }), now: NOW }).mode).toBe("fresh");
	});

	it("treats a future timestamp as just-now rather than as an enormous age", () => {
		// Clock skew between the D1 writer and this reader must not manufacture a fresh start.
		expect(resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: NOW + 3_600_000 }), now: NOW }).mode).toBe("resume");
	});

	it("survives the reap it is meant to survive", () => {
		// The whole point. A session reaped at the 6h idle mark is re-opened later the same day and
		// must come back with its conversation — before #408 that path was always cold.
		const reapedAt = NOW - IDLE_SESSION_MS - 3_600_000;
		expect(resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: reapedAt }), now: NOW }).mode).toBe("resume");
	});

	it("an explicit Fresh beats the freshest possible previous session", () => {
		// The console's Fresh button and MCP's `coding_session_fresh` END a session and open another
		// in the same breath, so the row they are escaping is the most resumable thing on the repo.
		// Without this branch first, "clean state, my CLI is wedged" would hand the wedged
		// conversation straight back — the feature deleted by a default.
		const r = resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: NOW }), forceFresh: true, now: NOW });
		expect(r.mode).toBe("fresh");
		expect(r.resumeFrom).toBeNull();
	});

	it("keeps the resume window strictly longer than the idle reap", () => {
		// If these ever crossed, a session could be reaped for idleness and then refused a resume
		// for the same idleness — the platform taking the context away twice for one absence, which
		// is the outcome #408's `coding_session_fresh` escape hatch exists to make DELIBERATE.
		expect(RESUME_WINDOW_MS).toBeGreaterThan(IDLE_SESSION_MS);
	});
});
