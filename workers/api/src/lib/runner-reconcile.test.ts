/**
 * #1113 slice 2 — the reconciliation plan enforces pin-scoped mutual exclusion.
 *
 * The issue's own acceptance tests, against a simulated GitHub: {@link apply} executes a plan's operations IN ORDER,
 * and {@link pickers} answers the only question that matters — which machines' runners could pick up this repo's
 * next job? A runner can take a job only if its group reaches the repo AND its labels cover the job's `runs-on`.
 * The answer is checked after EVERY operation of a re-pin, not only at the end, because the ordering is the point.
 */
import { describe, expect, it } from "vitest";
import { type ActualState, type DesiredRepo, planReconciliation, type ReconcileOp } from "./runner-reconcile.js";
import { GITHUB_HOSTED_LABEL, isPinScoped, nodeRunnerLabel } from "./runner-routing.js";

const REPO = "pas-apps/interns";
const NODES = ["Sergeys-Mac-mini.local", "pink-laptop", "dell-laptop"];
const EXHAUSTED = { exhausted: true };

/** A runner on `node` carries `self-hosted`, `pags` and its own `pags-<node>`. */
const runnerLabels = (node: string) => ["self-hosted", "pags", nodeRunnerLabel(node)];

function state(over: Partial<ActualState> = {}): ActualState {
	return { groupAccess: Object.fromEntries(NODES.map((n) => [n, []])), variables: {}, queuedRuns: [], onlineNodes: new Set(NODES), ...over };
}

/** Execute one operation against the simulated GitHub. */
function step(s: ActualState, op: ReconcileOp): ActualState {
	const groupAccess = Object.fromEntries(Object.entries(s.groupAccess).map(([n, r]) => [n, [...r]]));
	if (op.op === "remove_repo_from_group") groupAccess[op.node] = groupAccess[op.node].filter((r) => r !== op.repo);
	if (op.op === "add_repo_to_group") groupAccess[op.node] = [...groupAccess[op.node], op.repo];
	const variables = op.op === "set_variable" ? { ...s.variables, [op.repo]: op.value } : s.variables;
	const queuedRuns = op.op === "cancel_and_redispatch" ? s.queuedRuns.filter((r) => r.runId !== op.runId) : s.queuedRuns;
	return { ...s, groupAccess, variables, queuedRuns };
}

const apply = (s: ActualState, ops: readonly ReconcileOp[]) => ops.reduce(step, s);

/** Which self-hosted machines could pick up `repo`'s next job; `["github-hosted"]` when it routes there. */
function pickers(s: ActualState, repo: string): string[] {
	const raw = s.variables[repo];
	const labels = raw ? (JSON.parse(raw) as string | string[]) : GITHUB_HOSTED_LABEL;
	const runsOn = Array.isArray(labels) ? labels : [labels];
	if (runsOn.length === 1 && runsOn[0] === GITHUB_HOSTED_LABEL) return ["github-hosted"];
	return NODES.filter((n) => s.groupAccess[n].includes(repo) && runsOn.every((l) => runnerLabels(n).includes(l)));
}

const repo = (pinnedNode: string | null, over: Partial<DesiredRepo> = {}): DesiredRepo => ({ repo: REPO, visibility: "private", pinnedNode, minutes: EXHAUSTED, ...over });

describe("pin-scoped mutual exclusion (#1113 acceptance)", () => {
	it("3 machines with the same checkout, Coder pinned to one: only the pinned machine can take a job", () => {
		const after = apply(state(), planReconciliation([repo("pink-laptop")], state()).ops);
		expect(pickers(after, REPO)).toEqual(["pink-laptop"]);
		expect(after.groupAccess["Sergeys-Mac-mini.local"]).toEqual([]);
		expect(after.groupAccess["dell-laptop"]).toEqual([]);
	});

	it("a re-pin: new jobs only on the new machine, the old label's queued run cancelled — and at NO step can two machines take a job", () => {
		const pinned = apply(state(), planReconciliation([repo("pink-laptop")], state()).ops);
		const withQueued = { ...pinned, queuedRuns: [{ repo: REPO, runId: 42, labels: ["self-hosted", nodeRunnerLabel("pink-laptop")] }] };
		const plan = planReconciliation([repo("dell-laptop")], withQueued);
		// The ordering #1113 requires: remove from the old group → set PAGS_RUNNER → add to the new group.
		expect(plan.ops.map((o) => o.op)).toEqual(["remove_repo_from_group", "set_variable", "add_repo_to_group", "cancel_and_redispatch"]);
		let s: ActualState = withQueued;
		for (const op of plan.ops) {
			s = step(s, op);
			expect(pickers(s, REPO).length, `after ${op.op}`).toBeLessThanOrEqual(1);
			expect(pickers(s, REPO)).not.toContain("pink-laptop");
		}
		expect(pickers(s, REPO)).toEqual(["dell-laptop"]);
		expect(s.queuedRuns).toEqual([]);
	});

	it("PAGS_RUNNER never holds only generic labels — every self-hosted value names exactly one machine", () => {
		for (const node of NODES) {
			const set = planReconciliation([repo(node)], state()).ops.find((o) => o.op === "set_variable");
			expect(set?.op === "set_variable" && isPinScoped(JSON.parse(set.value))).toBe(true);
		}
		// And a generic value already there is reported and replaced.
		const generic = state({ variables: { [REPO]: JSON.stringify(["self-hosted", "pags"]) } });
		const plan = planReconciliation([repo("pink-laptop")], generic);
		expect(plan.violations).toEqual([expect.objectContaining({ kind: "generic_route" })]);
		expect(pickers(apply(generic, plan.ops), REPO)).toEqual(["pink-laptop"]);
	});

	it("unpinned: the repo's jobs run on GitHub-hosted only, and no group keeps it", () => {
		const pinned = apply(state(), planReconciliation([repo("pink-laptop")], state()).ops);
		const after = apply(pinned, planReconciliation([repo(null)], pinned).ops);
		expect(pickers(after, REPO)).toEqual(["github-hosted"]);
		expect(Object.values(after.groupAccess).flat()).toEqual([]);
	});
});

describe("violations are fixed and reported (#1113)", () => {
	it("a repo reachable by more than one machine's runner is a violation, fixed in the same plan", () => {
		const drifted = state({ groupAccess: { "Sergeys-Mac-mini.local": [REPO], "pink-laptop": [REPO], "dell-laptop": [REPO] } });
		const plan = planReconciliation([repo("pink-laptop")], drifted);
		expect(plan.violations).toEqual([expect.objectContaining({ kind: "multiple_machines" })]);
		const after = apply(drifted, plan.ops);
		expect(Object.entries(after.groupAccess).filter(([, r]) => r.includes(REPO)).map(([n]) => n)).toEqual(["pink-laptop"]);
	});

	it("a public repo is never added, and one found in a group is removed and reported", () => {
		expect(planReconciliation([repo("pink-laptop", { visibility: "public" })], state()).ops.some((o) => o.op === "add_repo_to_group")).toBe(false);
		const leaked = state({ groupAccess: { ...state().groupAccess, "pink-laptop": [REPO] } });
		const plan = planReconciliation([repo("pink-laptop", { visibility: "public" })], leaked);
		expect(plan.violations).toEqual([expect.objectContaining({ kind: "public_repo_in_group" })]);
		expect(apply(leaked, plan.ops).groupAccess["pink-laptop"]).toEqual([]);
	});

	it("a repo no Coder pins any more is removed from the group that still has it", () => {
		const orphan = state({ groupAccess: { ...state().groupAccess, "dell-laptop": ["pas-apps/old-app"] } });
		expect(apply(orphan, planReconciliation([], orphan).ops).groupAccess["dell-laptop"]).toEqual([]);
	});
});

describe("routing with minutes and machine availability (#1113 priority logic)", () => {
	it("GitHub-hosted by default — minutes remaining means no self-hosted route, even pinned", () => {
		const after = apply(state(), planReconciliation([repo("pink-laptop", { minutes: { usedPercent: 40 } })], state()).ops);
		expect(pickers(after, REPO)).toEqual(["github-hosted"]);
		// The group still holds the repo — membership follows the PIN; the route follows the minutes.
		expect(after.groupAccess["pink-laptop"]).toEqual([REPO]);
	});

	it("pinned machine offline with minutes left: GitHub-hosted, and the owner told", () => {
		const offline = state({ onlineNodes: new Set(["dell-laptop"]) });
		const plan = planReconciliation([repo("pink-laptop", { minutes: { usedPercent: 95 } })], offline);
		expect(pickers(apply(offline, plan.ops), REPO)).toEqual(["github-hosted"]);
		expect(plan.ops).toContainEqual(expect.objectContaining({ op: "alert", message: expect.stringMatching(/offline.*GitHub-hosted/) }));
	});

	it("pinned machine offline with NO minutes: the route waits for the machine and the owner is alerted — never queued silently", () => {
		const offline = state({ onlineNodes: new Set() });
		const plan = planReconciliation([repo("pink-laptop")], offline);
		expect(pickers(apply(offline, plan.ops), REPO)).toEqual(["pink-laptop"]);
		expect(plan.ops).toContainEqual(expect.objectContaining({ op: "alert", message: expect.stringMatching(/waiting for pink-laptop.*minutes are exhausted/) }));
	});

	it("is idempotent: run against the state its own plan produced, it plans nothing", () => {
		const desired = [repo("pink-laptop")];
		const after = apply(state(), planReconciliation(desired, state()).ops);
		expect(planReconciliation(desired, after)).toEqual({ ops: [], violations: [] });
	});
});
