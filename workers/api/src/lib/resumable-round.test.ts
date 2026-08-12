import { describe, expect, it, vi } from "vitest";
import {
	autoResumableRoundOf,
	buildResumableRound,
	isResumableFor,
	RESUMABLE_MAX_BYTES,
	RESUMABLE_TTL_MS,
	type ResumableRound,
	resumableRoundOf,
	thinkWithAutoResume,
	withResumableRound,
} from "./resumable-round.js";

const NOW = 1_800_000_000_000;

/** A round shaped like the one `runAgentThink` accumulates: one assistant turn, one result turn. */
const round = (over: Partial<ResumableRound> = {}): ResumableRound => ({
	prompt: "Start implementing",
	savedAt: NOW,
	roundsUsed: 1,
	executed: [["github_read_issue:{\"number\":402}", 0]],
	mutations: 0,
	executedTools: ["github_read_issue"],
	toolLog: ["✅ **github_read_issue** #402 — the capability-constraint gate…"],
	messages: [
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "github_read_issue", input: { number: 402 } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "…1658 chars…" }] },
	],
	...over,
});

describe("isResumableFor — three ways to be invalid, all silent if missed", () => {
	it("resumes a retry of the SAME question, inside the TTL", () => {
		expect(isResumableFor(round(), "Start implementing", NOW + 1000)).toBe(true);
	});

	it("refuses a DIFFERENT question — the results were fetched for another one", () => {
		// The whole hazard of resuming: answering a question nobody asked with a tool result that
		// belonged to a previous one. Nothing about the stored round says which question it is for
		// except this field, so it is compared exactly.
		expect(isResumableFor(round(), "Start implementing something else", NOW + 1000)).toBe(false);
		expect(isResumableFor(round(), "", NOW + 1000)).toBe(false);
	});

	it("expires — a resumed read from yesterday is worse than a re-fetch", () => {
		expect(isResumableFor(round(), "Start implementing", NOW + RESUMABLE_TTL_MS - 1)).toBe(true);
		expect(isResumableFor(round(), "Start implementing", NOW + RESUMABLE_TTL_MS + 1)).toBe(false);
	});

	it("refuses a round in which nothing actually executed", () => {
		// Resuming one would skip straight to the final answer with an empty transcript — the model
		// asked to conclude from results it was never shown.
		expect(isResumableFor(round({ messages: [] }), "Start implementing", NOW)).toBe(false);
		expect(isResumableFor(round({ executedTools: [] }), "Start implementing", NOW)).toBe(false);
	});

	it("refuses nothing at all, without throwing", () => {
		expect(isResumableFor(null, "x", NOW)).toBe(false);
		expect(isResumableFor(undefined, "x", NOW)).toBe(false);
	});
});

describe("buildResumableRound — stores only what is worth resuming", () => {
	it("stamps the save time and keeps the round verbatim", () => {
		const built = buildResumableRound({ ...round(), savedAt: undefined as never }, NOW);
		expect(built?.savedAt).toBe(NOW);
		expect(built?.messages).toHaveLength(2);
		expect(built?.executed).toEqual([["github_read_issue:{\"number\":402}", 0]]);
	});

	it("returns null when nothing ran, so the caller has ONE thing to check", () => {
		expect(buildResumableRound({ ...round(), messages: [] }, NOW)).toBeNull();
		expect(buildResumableRound({ ...round(), executedTools: [] }, NOW)).toBeNull();
	});

	it("returns null over the byte ceiling rather than storing a truncated round", () => {
		// Truncating is the dangerous option: a `tool_result` whose `tool_use` was cut away is a
		// request the provider rejects outright. Falling back to today's behaviour — re-run the
		// tool — is always correct, merely slower.
		const huge = round({ messages: [{ role: "user", content: "x".repeat(RESUMABLE_MAX_BYTES + 1) }, ...round().messages] });
		expect(buildResumableRound(huge, NOW)).toBeNull();
	});

	it("returns null for content that will not serialize, instead of throwing on the error path", () => {
		// This runs while an error is already being handled. A throw here would replace a provider
		// failure the user can retry with a crash they cannot.
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => buildResumableRound(round({ messages: [{ role: "user", content: cyclic }] }), NOW)).not.toThrow();
		expect(buildResumableRound(round({ messages: [{ role: "user", content: cyclic }] }), NOW)).toBeNull();
	});
});

describe("the error is the seam between the thinker and the DO", () => {
	it("attaches the round and returns the SAME error, preserving type and status", () => {
		// Same contract as `withPartialToolLog`: a creds/provider error must still propagate as
		// itself, with its status, or a 401 becomes a 500.
		const err = Object.assign(new Error("overloaded"), { status: 529 });
		const out = withResumableRound(err, round()) as { status?: number };
		expect(out).toBe(err);
		expect(out.status).toBe(529);
		expect(resumableRoundOf(err)?.prompt).toBe("Start implementing");
	});

	it("no-ops for a null round or a non-object error", () => {
		const err = new Error("round 0 failed, nothing ran");
		expect(withResumableRound(err, null)).toBe(err);
		expect(resumableRoundOf(err)).toBeNull();
		expect(() => withResumableRound("string error", round())).not.toThrow();
		expect(resumableRoundOf("string error")).toBeNull();
		expect(resumableRoundOf(undefined)).toBeNull();
	});
});

describe("what a resumed turn is fed — the shape #398 requires", () => {
	it("carries structured tool_use/tool_result blocks, never the `I called tools:` prose", () => {
		// Re-entering through the prose shape would undo #398 and re-teach the format #395's
		// fabrication imitated. The stored messages must be the protocol, not a narration of it.
		const r = round();
		expect(JSON.stringify(r.messages)).not.toContain("I called tools");
		expect(r.messages[0]).toMatchObject({ role: "assistant" });
		expect(JSON.stringify(r.messages[0].content)).toContain("tool_use");
		expect(r.messages[1]).toMatchObject({ role: "user" });
		expect(JSON.stringify(r.messages[1].content)).toContain("tool_result");
	});

	it("carries the dedup state, which is what stops a WRITE running twice", () => {
		// The in-turn dedup is scoped to one request and cannot see the previous one. Where the
		// failed round's tools were writes, a retry without this re-commits the side effect — the
		// duplicate the dedup exists to prevent, reached through the door it cannot see.
		const r = round({ executed: [["create_task:{\"title\":\"ship it\"}", 0]], mutations: 1, executedTools: ["create_task"] });
		expect(new Map(r.executed).has("create_task:{\"title\":\"ship it\"}")).toBe(true);
		expect(r.mutations).toBe(1);
	});

	it("pairs the rounds — `roundsUsed` must match the assistant/result turns stored", () => {
		// A resumed turn re-enters the loop at `roundsUsed`, so a count that disagrees with the
		// replayed messages either re-spends the budget or skips rounds that never happened.
		const r = round();
		expect(r.messages.length).toBe(r.roundsUsed * 2);
	});
});

/** A failure shaped like the one the provider client raises: a round, and its own verdict on retrying. */
const failure = (opts: { round?: ResumableRound | null; retryable?: boolean } = {}): Error => {
	const err = Object.assign(new Error("The AI provider stopped sending mid-reply"), { status: 504 });
	if (opts.retryable !== undefined) Object.assign(err, { retryable: opts.retryable });
	return withResumableRound(err, opts.round === undefined ? round() : opts.round) as Error;
};

describe("autoResumableRoundOf — which failures the platform retries for the user (#518)", () => {
	it("takes the round when the provider says a retry could work", () => {
		expect(autoResumableRoundOf(failure({ retryable: true }))?.prompt).toBe("Start implementing");
	});

	it("declines the deterministic failures, whose own message says a retry fails identically", () => {
		// The `total` deadline, an invalid key, a model the key cannot reach. Retrying these spends
		// the user's credit to reproduce the same error — the exact behaviour #427 removed from the
		// error text, which would be pointless to reintroduce as an automatic action.
		expect(autoResumableRoundOf(failure({ retryable: false }))).toBeNull();
		expect(autoResumableRoundOf(failure())).toBeNull();
	});

	it("declines when nothing executed — there is no work to protect and no reason to pay twice", () => {
		expect(autoResumableRoundOf(failure({ round: null, retryable: true }))).toBeNull();
	});

	it("tolerates a non-object error", () => {
		expect(autoResumableRoundOf("string error")).toBeNull();
		expect(autoResumableRoundOf(undefined)).toBeNull();
	});
});

/**
 * #518's sixth acceptance criterion, and the reason it was written: #442's tests all proved a round
 * is BUILT correctly. Not one of them proved anything ever reads one back, which is precisely how a
 * feature ships correct and unreachable. These assert the round is CONSUMED — handed to a second
 * attempt — and that the attempt is bounded.
 */
describe("thinkWithAutoResume — the stored round is consumed, not merely stored (#518)", () => {
	it("hands the SAME round to a second attempt and returns its answer", async () => {
		const stored = round();
		const seen: (ResumableRound | undefined)[] = [];
		const think = vi.fn(async (resume?: ResumableRound) => {
			seen.push(resume);
			if (seen.length === 1) throw withResumableRound(Object.assign(new Error("stall"), { retryable: true }), stored);
			return "the answer, built on results already in hand";
		});

		await expect(thinkWithAutoResume(think)).resolves.toBe("the answer, built on results already in hand");
		expect(think).toHaveBeenCalledTimes(2);
		expect(seen[0]).toBeUndefined();
		// Identity, not shape: what the second attempt gets must be the round the FIRST one paid
		// for. A copy assembled from somewhere else would pass a `toEqual` and re-run the tools.
		expect(seen[1]).toBe(stored);
	});

	it("carries the executed-tool ledger into the retry, so an identical write cannot run twice", async () => {
		// The dedup that stops it lives in `runAgentThink` and is seeded from these two fields. What
		// is asserted here is that they ARRIVE: `executed` naming the write, and the mutation count
		// its read-repeat rule is keyed to.
		const stored = round({ executed: [["create_task:{\"title\":\"ship it\"}", 0]], mutations: 1, executedTools: ["create_task"] });
		let received: ResumableRound | undefined;
		await thinkWithAutoResume(async (resume) => {
			if (!resume) throw withResumableRound(Object.assign(new Error("stall"), { retryable: true }), stored);
			received = resume;
			return "done";
		});
		expect(new Map(received?.executed ?? []).get("create_task:{\"title\":\"ship it\"}")).toBe(0);
		expect(received?.mutations).toBe(1);
		expect(received?.executedTools).toEqual(["create_task"]);
	});

	it("starts from a round the CALLER validated, when the user's own retry brought one", async () => {
		const stored = round();
		const think = vi.fn(async () => "answered from the stored round");
		await expect(thinkWithAutoResume(think, { resume: stored })).resolves.toBe("answered from the stored round");
		expect(think).toHaveBeenCalledWith(stored);
	});

	it("retries exactly once — a second failure is about the provider, not this turn", async () => {
		const think = vi.fn(async () => {
			throw withResumableRound(Object.assign(new Error("still down"), { retryable: true }), round());
		});
		await expect(thinkWithAutoResume(think)).rejects.toThrow("still down");
		expect(think).toHaveBeenCalledTimes(2);
	});

	it("leaves the second failure carrying its round, so the manual path still works", async () => {
		const think = vi.fn(async () => {
			throw withResumableRound(Object.assign(new Error("still down"), { retryable: true }), round());
		});
		const err = await thinkWithAutoResume(think).catch((e) => e);
		expect(resumableRoundOf(err)?.executedTools).toEqual(["github_read_issue"]);
	});

	it("does not retry a failure with no round, or one the provider called deterministic", async () => {
		const noRound = vi.fn(async () => {
			throw Object.assign(new Error("nothing ran"), { retryable: true });
		});
		await expect(thinkWithAutoResume(noRound)).rejects.toThrow("nothing ran");
		expect(noRound).toHaveBeenCalledTimes(1);

		const deterministic = vi.fn(async () => {
			throw withResumableRound(new Error("reply was too long to finish"), round());
		});
		await expect(thinkWithAutoResume(deterministic)).rejects.toThrow("too long");
		expect(deterministic).toHaveBeenCalledTimes(1);
	});

	it("reports the recovery, and retries even when reporting it fails", async () => {
		const seen: string[] = [];
		const think = vi.fn(async (resume?: ResumableRound) => {
			if (!resume) throw withResumableRound(Object.assign(new Error("stall"), { retryable: true }), round());
			return "recovered";
		});
		await expect(
			thinkWithAutoResume(think, {
				onAutoResume: async (r, err) => {
					seen.push(`${r.executedTools.join(",")}|${(err as Error).message}`);
					throw new Error("D1 is having a moment");
				},
			}),
		).resolves.toBe("recovered");
		expect(seen).toEqual(["github_read_issue|stall"]);
	});
});
