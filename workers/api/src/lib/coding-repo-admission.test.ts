import { describe, expect, it } from "vitest";
import { admitRepoForRun, wouldCloneInto } from "./coding-repo-admission.js";
import type { WorkdirVerdict } from "./coding-workdir.js";
import type { AdmissibleRepo } from "./coding-repo-admission.js";

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

describe("admitRepoForRun — an absent or EMPTY checkout with a clone source is admitted, the start clones it (#828)", () => {
	const empty = repo({ cloneStatus: "needs_attention", cloneError: "…exists but is EMPTY…", githubRepo: "freeappstore-online/platform" });
	const live = (state: WorkdirVerdict["state"]): WorkdirVerdict => ({ state, path: "/Users/serge/dev/stores/fas/platform", detail: "" });

	it("admits on a LIVE empty or missing verdict", () => {
		expect(admitRepoForRun(empty, live("empty"))).toEqual({ ok: true });
		expect(admitRepoForRun(empty, live("missing"))).toEqual({ ok: true });
	});

	it("admits a managed binding with no folder when it can derive a clone source", () => {
		// This is not permission to overwrite a local folder: without `workdir` the runner creates
		// its own managed destination. It also repairs legacy rows whose old local-path verdict
		// survived after the folder was cleared.
		expect(admitRepoForRun({ ...empty, workdir: undefined })).toEqual({ ok: true });
	});

	it("keeps refusing without a live verdict, or with one that a clone cannot fix", () => {
		expect(admitRepoForRun(empty).ok).toBe(false);
		expect(admitRepoForRun(empty, live("unverified")).ok).toBe(false);
		// A plain folder with files: cloning over it would be data loss.
		expect(admitRepoForRun(empty, live("not_a_git_repo")).ok).toBe(false);
	});

	it("keeps refusing when the repo names nothing to clone from", () => {
		expect(wouldCloneInto(repo({ cloneStatus: "needs_attention" }), live("empty"))).toBe(false);
		expect(wouldCloneInto(repo({ cloneStatus: "needs_attention", webUrl: "https://gitlab.com/g/p" }), live("empty"))).toBe(true);
	});
});
