import { describe, expect, it } from "vitest";
import { admitRepoForRun } from "./coding-repo-admission.js";
import type { AdmissibleRepo } from "./coding-repo-admission.js";
import type { WorkdirVerdict } from "./coding-workdir.js";

const repo = (over: Partial<AdmissibleRepo> = {}): AdmissibleRepo => ({
	name: "dev/aipa",
	cloneStatus: "ready",
	workdir: "~/dev/aipa",
	...over,
});

// The sentence #405 actually wrote to the row this issue is about, verbatim from production D1.
const AIPA_ERROR =
	"The configured checkout `/Users/serge-ivo/dev/aipa` has files but is not inside a git working tree — it is a plain folder, not a clone of a repository.";

describe("admitRepoForRun — a run must not start on a folder the platform has already condemned (#548)", () => {
	it("refuses a repo whose stored verdict is needs_attention", () => {
		const out = admitRepoForRun(repo({ cloneStatus: "needs_attention", cloneError: AIPA_ERROR }));
		expect(out.ok).toBe(false);
	});

	it("relays #405's sentence verbatim, so the refusal names the folder and says `git`", () => {
		// The measured failure: three `git pull` runs, 45 minutes, and the word "git" appeared
		// nowhere in what the owner was told ("stuck not resolved in time") — while D1 held this
		// exact sentence the whole time. `clone_error` is written to be relayed (coding-workdir.ts
		// § detail), so the refusal must not paraphrase it into something more generic.
		const out = admitRepoForRun(repo({ cloneStatus: "needs_attention", cloneError: AIPA_ERROR }));
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.message).toContain(AIPA_ERROR);
			expect(out.message).toContain("/Users/serge-ivo/dev/aipa");
			expect(out.message).toMatch(/git working tree/);
		}
	});

	it("names a remedy that can actually be acted on, and never `pags up`", () => {
		// #468/#530, twice fixed: a refusal whose remedy is `pags up` for a problem `pags up`
		// cannot fix. A Lead relays this sentence to its owner, so prescribing the runner here
		// would send them to a terminal instead of to the folder. The block is lifted by the same
		// probe that imposed it, so Re-check has to be reachable from the words.
		const out = admitRepoForRun(repo({ cloneStatus: "needs_attention", cloneError: AIPA_ERROR }));
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.message).toMatch(/Re-check/i);
			expect(out.message).not.toMatch(/pags up/);
		}
	});

	it("still names the folder when the row lost its detail", () => {
		const out = admitRepoForRun(repo({ cloneStatus: "needs_attention", cloneError: "   " }));
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.message).toContain("~/dev/aipa");
	});

	// ── The other half of the rule: ONLY a definite verdict blocks ────────────────────────────
	it("admits `unknown` — nobody has looked, which is not a condemnation", () => {
		// An offline laptop, or a machine that has never been up while the console was open. A
		// block here would stop every run on it, which is a far larger outage than the bug.
		expect(admitRepoForRun(repo({ cloneStatus: "unknown" }))).toEqual({ ok: true });
	});

	it("admits `error` — that status is a transport/launch failure, not a filesystem verdict", () => {
		// #440: `clone_status = "error"` was written for a dropped WebSocket for five days on a
		// healthy checkout. Rows predating that fix still carry it, and treating one as a wall
		// would turn a stale transport failure into a permanent refusal.
		expect(admitRepoForRun(repo({ cloneStatus: "error", cloneError: "No runner connected" }))).toEqual({ ok: true });
	});

	it("admits `ready`, `cloning` and `missing_url`", () => {
		expect(admitRepoForRun(repo({ cloneStatus: "ready" }))).toEqual({ ok: true });
		// A managed clone that has not landed yet — `startSessionOnRunner` is what clones it.
		expect(admitRepoForRun(repo({ cloneStatus: "cloning", workdir: undefined }))).toEqual({ ok: true });
		// The open path has its own, better message for "no source configured".
		expect(admitRepoForRun(repo({ cloneStatus: "missing_url", workdir: undefined }))).toEqual({ ok: true });
	});
});

describe("admitRepoForRun — an empty or absent checkout is cloned into, not refused (#828)", () => {
	// The reported row, as production D1 holds it: identified as GitHub, no clone URL stored.
	const fas = (over: Partial<AdmissibleRepo> = {}) =>
		repo({
			name: "fas/platform",
			workdir: "~/dev/stores/fas/platform",
			cloneStatus: "needs_attention",
			cloneError: "The configured checkout `/Users/serge/dev/stores/fas/platform` exists but is EMPTY — nothing was ever cloned into it, or its contents were moved away. There is no code at that path to read.",
			provider: "github",
			githubRepo: "freeappstore-online/platform",
			...over,
		});
	const verdict = (state: WorkdirVerdict["state"], detail = `detail for ${state}`): WorkdirVerdict => ({ state, path: "/Users/serge-ivo/dev/stores/fas/platform", detail });

	it("admits an EMPTY folder on the machine about to run, when the repo has a remote", () => {
		expect(admitRepoForRun(fas(), verdict("empty"))).toEqual({ ok: true });
	});

	it("admits an ABSENT folder the same way — a machine that never cloned this repo is normal", () => {
		expect(admitRepoForRun(fas(), verdict("missing"))).toEqual({ ok: true });
	});

	it("admits when the machine now says the checkout is fine — the stored verdict was another machine's", () => {
		expect(admitRepoForRun(fas(), verdict("ok"))).toEqual({ ok: true });
	});

	it("refuses an empty folder with nothing to clone from, and says THAT rather than 'fix the folder'", () => {
		const out = admitRepoForRun(fas({ provider: "local", githubRepo: undefined }), verdict("empty", "EMPTY-DETAIL"));
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.message).toContain("EMPTY-DETAIL");
			expect(out.message).toMatch(/no remote to clone it from/);
		}
	});

	it("still refuses a plain folder with files, even with a remote — a clone would have to replace them", () => {
		const out = admitRepoForRun(fas(), verdict("not_a_git_repo", AIPA_ERROR));
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.message).toContain(AIPA_ERROR);
	});

	it("falls back to the STORED verdict when the machine could not answer", () => {
		const out = admitRepoForRun(fas(), verdict("unverified"));
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.message).toContain("/Users/serge/dev/stores/fas/platform");
		expect(admitRepoForRun(fas(), null).ok).toBe(false);
	});

	it("ignores a live verdict for a repo that was not condemned — nothing new is gated", () => {
		expect(admitRepoForRun(fas({ cloneStatus: "ready" }), verdict("not_a_git_repo")).ok).toBe(true);
	});
});
