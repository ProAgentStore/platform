/**
 * #1233 — brain-free auto-pickup: the deterministic picker (pure), and the wake on the real schema.
 * GitHub, the issue comment, the notification and the queue kick are the only fakes; there is no
 * model anywhere in this path, and the env below has no AI binding or key to call one with.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { AUTO_PICKUP_DEFAULTS, type AutoPickupDeps, type PickCandidate, autoPickupFrom, autoPickupPatchProblem, autoPickupStatus, pickNextIssue, priorityRank, runAutoPickup, setAutoPickup, wakeIdleCoder } from "./auto-pickup.js";
import { setCoderBrain } from "./coder-brain.js";
import type { IssueSummary } from "./github-issues.js";
import type { Env } from "../types.js";

const issue = (number: number, labels: string[] = [], assignees: string[] = []): IssueSummary => ({ number, title: `issue ${number}`, state: "open", labels, assignees, comments: 0, updatedAt: "", url: `u/${number}` });
const cand = (i: IssueSummary, over: Partial<PickCandidate> = {}): PickCandidate => ({ repo: "acme/app", repoId: "r1", issue: i, boardPosition: null, failures: 0, inFlight: false, ...over });
const pick = (cs: PickCandidate[], settings = AUTO_PICKUP_DEFAULTS) => {
	const v = pickNextIssue(cs, settings);
	return v.pick?.issue.number ?? null;
};

describe("the picker is deterministic and never random (#1233)", () => {
	it("a P1 bug beats an older P3, and P0 beats both", () => {
		expect(pick([cand(issue(3, ["P3"])), cand(issue(9, ["P1", "bug"]))])).toBe(9);
		expect(pick([cand(issue(3, ["P3"])), cand(issue(9, ["P1", "bug"])), cand(issue(12, ["P0"]))])).toBe(12);
	});

	it("matches labels like `P1: blocks external users`, and not `P10` as P1", () => {
		expect(priorityRank(["P1: blocks external users"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(1);
		expect(priorityRank(["p2 - nice"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(2);
		expect(priorityRank(["P10"], AUTO_PICKUP_DEFAULTS.priorityLabels)).toBe(4);
	});

	it("bug before unlabelled before enhancement, then board order, then oldest", () => {
		expect(pick([cand(issue(1, ["enhancement"])), cand(issue(2)), cand(issue(3, ["bug"]))])).toBe(3);
		expect(pick([cand(issue(1, ["enhancement"])), cand(issue(2))])).toBe(2);
		// Same rank: the card the owner placed first wins; an unplaced card comes after every placed one.
		expect(pick([cand(issue(1)), cand(issue(7), { boardPosition: 2 }), cand(issue(9), { boardPosition: 1 })])).toBe(9);
		// Same rank, nothing placed: the oldest (lowest number).
		expect(pick([cand(issue(8)), cand(issue(4)), cand(issue(6))])).toBe(4);
	});

	it("never picks needs-human, blocked, question, wontfix, an owner exclude label, a person's issue, one in flight, or one failed twice", () => {
		const out = [
			cand(issue(1, ["needs-human", "P0"])),
			cand(issue(2, ["blocked-on-serge", "P0"])),
			cand(issue(3, ["Blocked", "P0"])),
			cand(issue(4, ["question", "P0"])),
			cand(issue(5, ["wontfix", "P0"])),
			cand(issue(6, ["design", "P0"])),
			cand(issue(7, ["P0"], ["serge-ivo"])),
			cand(issue(8, ["P0"]), { inFlight: true }),
			cand(issue(9, ["P0"]), { failures: 2 }),
		];
		const settings = { ...AUTO_PICKUP_DEFAULTS, excludeLabels: ["design"] };
		expect(pickNextIssue(out, settings)).toMatchObject({ pick: null, reason: "none of the 9 open issue(s) qualifies" });
		// A bot assignee is not a person holding it, and one failure is not two.
		expect(pick([cand(issue(10, [], ["dependabot[bot]"]))])).toBe(10);
		expect(pick([cand(issue(11), { failures: 1 })])).toBe(11);
		expect(pickNextIssue([cand(issue(9), { failures: 2 })], settings).skippedFailed.map((c) => c.issue.number)).toEqual([9]);
	});

	it("an owner's priority labels replace the default order", () => {
		const settings = { ...AUTO_PICKUP_DEFAULTS, priorityLabels: ["urgent", "soon"] };
		expect(pick([cand(issue(1, ["P0"])), cand(issue(2, ["soon"])), cand(issue(3, ["urgent"]))], settings)).toBe(3);
	});

	it("settings are validated at the write and defaulted at the read", () => {
		expect(autoPickupFrom(null)).toEqual(AUTO_PICKUP_DEFAULTS);
		expect(autoPickupFrom({ autoPickup: { enabled: true, maxPerDay: 999 } })).toMatchObject({ enabled: true, maxPerDay: 10, maxIterations: 30 });
		expect(autoPickupPatchProblem({ enabled: "yes" })).toMatch(/true or false/);
		expect(autoPickupPatchProblem({ priorityLabels: Array.from({ length: 21 }, (_, i) => `L${i}`) })).toMatch(/at most 20/);
		expect(autoPickupPatchProblem({ maxIterations: 0 })).toMatch(/1 to 100/);
		expect(autoPickupPatchProblem({ surprise: 1 })).toMatch(/Unknown/);
		expect(autoPickupPatchProblem({ enabled: true, excludeLabels: ["design"], maxPerDay: 3 })).toBeNull();
	});
});

describe("the wake, on the real schema (#1233)", () => {
	let d1: RealSchemaD1;
	let env: Env;
	let open: IssueSummary[];
	let log: { started: string[]; comments: number[]; notes: string[] };
	const deps = (): AutoPickupDeps => ({
		listOpenIssues: async () => ({ issues: open, unreadable: false }),
		postComment: async (_repo, n) => {
			log.comments.push(n);
			return true;
		},
		notify: async (_t, body) => void log.notes.push(body),
		startQueued: async (repoId) => void log.started.push(repoId),
	});
	const queued = () => d1.sqlite.prepare("SELECT objective, max_iterations, metadata FROM instance_objective_queue WHERE status = 'pending'").all() as Array<{ objective: string; max_iterations: number; metadata: string }>;

	beforeEach(async () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'coder', 'u1', 'app', 'acme/app')`);
		env = { DB: d1.DB } as unknown as Env;
		open = [issue(3, ["P3"]), issue(9, ["P1", "bug"]), issue(1, ["needs-human", "P0"])];
		log = { started: [], comments: [], notes: [] };
		await setAutoPickup(env, "coder", "u1", { enabled: true });
	});
	afterEach(() => d1.close());

	it("an empty queue starts the highest-priority eligible issue: queued with its iterations, and kicked at once", async () => {
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, repo: "acme/app", issue: 9 });
		const [entry] = queued();
		expect(entry.objective).toMatch(/^Implement GitHub issue #9 in acme\/app: issue 9\. Read the issue and all its comments first\..*"closes #9"/);
		expect(entry.max_iterations).toBe(30);
		expect(JSON.parse(entry.metadata)).toEqual({ autoPickup: { repo: "acme/app", issue: 9 } });
		expect(log.started).toEqual(["r1"]);
		expect(await autoPickupStatus(env, "coder", "u1")).toMatchObject({ enabled: true, picker: "auto_pickup", last: { outcome: "started" } });
	});

	it("off is off, and a coder with work does not pick", async () => {
		await setAutoPickup(env, "coder", "u1", { enabled: false });
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "auto-pickup is off for this instance" });
		await setAutoPickup(env, "coder", "u1", { enabled: true });
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('busy', 'u1', 'coder', 'x', 'running', 10, 1)`);
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "the coder still has queued or running work" });
		expect(queued()).toEqual([]);
	});

	it("nothing eligible: the coder stays idle and the owner is told ONCE, not on every empty queue", async () => {
		open = [issue(1, ["needs-human"])];
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/none of the 1 open issue/) });
		await runAutoPickup(env, "coder", "u1", deps());
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.notes).toHaveLength(1);
		expect(log.notes[0]).toMatch(/queue is empty/);
		// Once it has picked something again, a later empty spell is news again.
		open = [issue(5)];
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		open = [];
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.notes).toHaveLength(2);
	});

	it("an issue two auto-picked runs ended failed on is skipped, with ONE comment on it, and the next one starts", async () => {
		open = [issue(9, ["P1", "bug"]), issue(3, ["P3"])];
		for (const n of [1, 2]) {
			d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, metadata, status, created_at) VALUES ('q${n}', 'coder', 'r1', 'u1', 'Implement GitHub issue #9', '{"autoPickup":{"repo":"acme/app","issue":9}}', 'started', ${n})`);
			d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, queue_entry_id) VALUES ('f${n}', 'u1', 'coder', 'Implement GitHub issue #9', 'failed', 30, ${n}, 'q${n}')`);
		}
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: true, issue: 3 });
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled' WHERE status = 'pending'");
		await runAutoPickup(env, "coder", "u1", deps());
		expect(log.comments).toEqual([9]);
	});

	it("stops at the daily cap", async () => {
		await setAutoPickup(env, "coder", "u1", { maxPerDay: 1 });
		await runAutoPickup(env, "coder", "u1", deps());
		d1.exec("UPDATE instance_objective_queue SET status = 'cancelled'");
		expect(await runAutoPickup(env, "coder", "u1", deps())).toEqual({ started: false, reason: "the daily cap of 1 auto-picked run(s) is reached" });
	});

	it("a paused instance picks nothing", async () => {
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		expect(await runAutoPickup(env, "coder", "u1", deps())).toMatchObject({ started: false, reason: expect.stringMatching(/paused/) });
		expect(queued()).toEqual([]);
	});

	it("an empty queue wakes ONE picker: triage when the brain's PO layer is on, auto-pickup otherwise", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: true, poEnabled: true });
		expect(await autoPickupStatus(env, "coder", "u1")).toMatchObject({ enabled: true, picker: "triage" });
		expect(await wakeIdleCoder(env, "coder", "u1")).toMatch(/^triage/);
		expect(queued().some((q) => q.metadata?.includes("autoPickup"))).toBe(false);
	});
});
