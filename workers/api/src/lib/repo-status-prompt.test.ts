/**
 * #416 — the chat prompt must RELAY #405's diagnosis, not the enum token that hid it.
 *
 * The measured case is at the top: an agent asked about `apps/chess-academy` was told
 * `needs_attention` and nothing else, while the sentence explaining that the checkout was empty
 * sat one field away on the same row. Two things are pinned here:
 *
 *   - the fix — every non-`ready` status renders its `cloneError`, not just `error`;
 *   - the defence — the phrase table is exhaustive over `CloneStatus`, so the obvious wrong fix
 *     (add a status, leave the prompt alone) cannot compile, and the obvious wrong REFACTOR
 *     (fall back to printing the raw token) fails a test.
 */
import { describe, expect, it } from "vitest";
import type { CloneStatus } from "./coding-types.js";
import {
	attachedReposPrompt,
	CLONE_STATUS_PHRASE,
	cloneStatusPhrase,
	MAX_DETAIL_CHARS,
	MAX_DIAGNOSED,
	repoStatusLine,
	type RepoStatusInput,
} from "./repo-status-prompt.js";

/** The exact sentence `verdictFromCheck` writes for an empty workdir (lib/coding-workdir.ts). */
const EMPTY_DETAIL =
	"The configured checkout `/Users/u/dev/pas/platform/apps/chess-academy` exists but is EMPTY — nothing was ever cloned into it, or its contents were moved away. There is no code at that path to read.";

const brokenRepo: RepoStatusInput = {
	name: "apps/chess-academy",
	cloneStatus: "needs_attention",
	cloneError: EMPTY_DETAIL,
};

describe("attachedReposPrompt — the diagnosis reaches the model (#416)", () => {
	it("relays the whole #405 sentence for a needs_attention repo", () => {
		const out = attachedReposPrompt([brokenRepo]);
		expect(out).toContain(EMPTY_DETAIL);
		expect(out).toContain("apps/chess-academy");
		expect(out).toContain("UNUSABLE");
	});

	// The regression this file exists to prevent: the block used to print the enum name, which is
	// not a thing an agent can say to its owner.
	it("never prints the bare enum token in place of prose", () => {
		const out = attachedReposPrompt([brokenRepo, { name: "b", cloneStatus: "unknown" }, { name: "c", cloneStatus: "missing_url" }]);
		expect(out).not.toMatch(/— needs_attention/);
		expect(out).not.toMatch(/— unknown/);
		expect(out).not.toMatch(/— missing_url/);
	});

	it("says what `unknown` actually means — nobody looked, so absence of a complaint proves nothing", () => {
		const out = attachedReposPrompt([{ name: "solo", cloneStatus: "unknown" }]);
		expect(out).toMatch(/not checked/i);
		expect(out).toMatch(/no machine connected/i);
	});

	// `cloneError` used to be read on exactly one branch. Every non-ready status carries one now.
	it.each<CloneStatus>(["unknown", "cloning", "missing_url", "error", "needs_attention"])("renders cloneError for %s", (status) => {
		const out = attachedReposPrompt([{ name: "r", cloneStatus: status, cloneError: "BECAUSE-THIS-HAPPENED" }]);
		expect(out).toContain("BECAUSE-THIS-HAPPENED");
	});

	it("does not attach a stale detail to a healthy repo", () => {
		const out = attachedReposPrompt([{ name: "r", cloneStatus: "ready", cloneError: "STALE" }]);
		expect(out).not.toContain("STALE");
		expect(out).toContain("- r — ready");
	});

	it("states that the verdict is the last recorded one, not a live check", () => {
		const out = attachedReposPrompt([brokenRepo]);
		expect(out).toMatch(/LAST RECORDED verdict/);
		expect(out).toMatch(/not a live check/);
	});

	// No timestamp is rendered on purpose: `updated_at` is bumped by any edit to the row, so a
	// "checked N minutes ago" would be a claim the platform cannot support. See the module comment.
	it("does not invent a time the check was taken", () => {
		const out = attachedReposPrompt([brokenRepo]);
		expect(out).not.toMatch(/\d+\s*(minutes?|hours?|days?)\s*ago/i);
	});

	it("returns nothing at all when there are no repos", () => {
		expect(attachedReposPrompt([])).toBe("");
	});
});

describe("attachedReposPrompt — bounded output", () => {
	const many: RepoStatusInput[] = Array.from({ length: MAX_DIAGNOSED + 4 }, (_, i) => ({
		name: `repo-${i}`,
		cloneStatus: "needs_attention",
		cloneError: `${EMPTY_DETAIL} (#${i})`,
	}));

	it("diagnoses the first N and counts the rest rather than dropping them silently", () => {
		const out = attachedReposPrompt(many);
		const detailCount = out.split("exists but is EMPTY").length - 1;
		expect(detailCount).toBe(MAX_DIAGNOSED);
		// Every repo still gets a line and a state, diagnosed or not.
		for (const r of many) expect(out).toContain(r.name);
		expect(out).toContain("4 further repositories are in a bad state");
	});

	it("truncates a single unbounded detail — the runner supplies that string", () => {
		const out = attachedReposPrompt([{ name: "r", cloneStatus: "error", cloneError: "x".repeat(5_000) }]);
		expect(out.length).toBeLessThan(MAX_DETAIL_CHARS + 600);
		expect(out).toContain("…");
	});
});

describe("the phrase table is the defence, not the ternary chain it replaced", () => {
	// This is the compile-time guard restated at runtime, so that deleting the `satisfies` (the
	// only thing making the next new status a build error) also breaks a test rather than passing
	// quietly. Keep the literal list: reading it from the type is impossible, and reading it from
	// the table under test would make the assertion vacuous.
	const ALL: CloneStatus[] = ["unknown", "cloning", "ready", "missing_url", "error", "needs_attention"];

	it("has a phrase for every CloneStatus", () => {
		expect(Object.keys(CLONE_STATUS_PHRASE).sort()).toEqual([...ALL].sort());
		for (const s of ALL) expect(CLONE_STATUS_PHRASE[s].length).toBeGreaterThan(0);
	});

	// `ready` is legitimately its own phrase — it is already English. The tell of a leaked token is
	// the snake_case, which is how `needs_attention` and `missing_url` reached the model.
	it("never hands the model a snake_case enum token", () => {
		for (const s of ALL) expect(cloneStatusPhrase(s)).not.toMatch(/[a-z]_[a-z]/);
	});

	// `clone_status` is a TEXT column: a value this build has never heard of must read as
	// "unrecognised", not be printed as though it were English.
	it("is honest about a status it does not know", () => {
		const phrase = cloneStatusPhrase("quantum_superposition");
		expect(phrase).not.toContain("quantum_superposition");
		expect(phrase).toMatch(/unrecognised/i);
	});
});

describe("repoStatusLine", () => {
	it("names the GitHub coordinate when there is one", () => {
		expect(repoStatusLine({ name: "platform", githubRepo: "ProAgentStore/platform", cloneStatus: "ready" })).toBe(
			"- platform (ProAgentStore/platform) — ready",
		);
	});

	it("suppresses the detail when the caller is over its diagnosis budget", () => {
		const line = repoStatusLine(brokenRepo, { withDetail: false });
		expect(line).toContain("UNUSABLE");
		expect(line).not.toContain(EMPTY_DETAIL);
	});
});
