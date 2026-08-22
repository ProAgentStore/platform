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

/**
 * EVERY decision this module can return, one per branch, in branch order.
 *
 * A single list rather than a fixture repeated per test, because two of the guarantees below are
 * about the DENOMINATOR — "every branch has a distinct reason", "every branch that is not an
 * explicit clean slate declares a seed source" — and a guarantee about all of them is worth exactly
 * as much as the list is complete. Adding a ninth branch without adding it here is the failure mode;
 * adding it here without giving it a seed source is what ADR 0005 asks to be impossible.
 */
const everyDecision = () => [
	resolveSessionContinuity({ engine: "claude", previous: null, forceFresh: true, now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: null, now: NOW }),
	resolveSessionContinuity({ engine: "codex", previous: prev(), now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: prev({ status: "error" }), now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: null }), now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: prev({ clientType: "codex" }), now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: prev({ lastActivityAt: NOW - 9 * 24 * 3_600_000 }), now: NOW }),
	resolveSessionContinuity({ engine: "claude", previous: prev(), now: NOW }),
];

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

	it("phrases every reason without the word 'session' (#695)", () => {
		// `reason` is not diagnostics — the console shows it on open (#697) and MCP returns it
		// (#696), so it is read by the user, verbatim, at the exact moment they are wondering
		// whether their work survived. #257 and #408 spent two issues making "session" a concept
		// nobody has to learn; a reason string is the cheapest place to teach it back to them.
		const decisions = everyDecision();
		// Every branch, not a sample: the check is only worth having if adding a branch trips it.
		expect(new Set(decisions.map((d) => d.reason)).size).toBe(decisions.length);
		for (const d of decisions) expect(d.reason).not.toMatch(/session/i);
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

	it("declares a seed source on every branch except the one the user asked for (ADR 0005)", () => {
		// THE enforcement clause of ADR 0005, and the reason it is written as a denominator.
		//
		// The violation this guards against is silent by construction: a cold engine looks exactly
		// like a warm one until someone asks it something it should remember. So "review it
		// carefully" is not a mechanism. What is: every decision must NAME the record it will seed
		// from, and the only value that may decline is the one the user requested. A ninth branch
		// added without a seed source fails HERE, at the moment it is written, rather than months
		// later when somebody notices their agent has forgotten a week of work.
		//
		// `forceFresh` is first in `everyDecision`, and it is the only exemption: per the ADR, "a
		// clean slate someone requested is a feature; a clean slate nobody chose is the defect this
		// record exists to prevent."
		const [clean, ...rest] = everyDecision();
		expect(clean.seed, "an explicit Fresh must NOT be seeded — that would delete the feature").toBeNull();
		expect(rest.length).toBe(7);
		for (const d of rest) expect(d.seed, `${d.mode}: "${d.reason}" starts an engine with no declared seed source`).toBe("repo-timeline");
	});

	it("seeds a RESUME too, because asking to resume is not resuming", () => {
		// A resume is a request the machine may not honour: a `pags up` older than #408 drops
		// `resumeFrom`, a relocated session's resume key is a file on the laptop it left (#694), and
		// `~/.claude` can simply have been cleared. `sessionOpenedNotice` has a whole branch for that
		// outcome and its own wording for it is "It started a FRESH conversation" — so withholding
		// the brief on `resume` would leave the ADR's guarantee broken on exactly the path that
		// produced it. The runner prefers its own conversation and only spends the brief when it has
		// none, so this does not make seeding primary for Claude.
		const r = resolveSessionContinuity({ engine: "claude", previous: prev(), now: NOW });
		expect(r.mode).toBe("resume");
		expect(r.seed).toBe("repo-timeline");
	});

	it("keeps the resume window strictly longer than the idle reap", () => {
		// If these ever crossed, a session could be reaped for idleness and then refused a resume
		// for the same idleness — the platform taking the context away twice for one absence, which
		// is the outcome #408's `coding_session_fresh` escape hatch exists to make DELIBERATE.
		expect(RESUME_WINDOW_MS).toBeGreaterThan(IDLE_SESSION_MS);
	});
});
