/**
 * #1211 — the executor performs the reconciliation plan in the plan's order, on the Free-plan topology (label-only exclusion).
 * Planned by the real `planReconciliation`; GitHub is simulated.
 */
import { describe, expect, it } from "vitest";
import { type ExecDeps, executePlan, GROUPLESS_REASON, withoutGroupOps } from "./runner-reconcile-exec.js";
import { type ActualState, type DesiredRepo, planReconciliation } from "./runner-reconcile.js";

const A = "mac-mini";
const B = "dell";
const LABELS_B = JSON.stringify(["self-hosted", "pags-dell"]);
const REPO = "proappstore-online/interns";

function sim(over: { writeStatus?: number } = {}) {
	const log: string[] = [];
	const variables = new Map<string, string>();
	const deps: ExecDeps & { log: string[]; variables: Map<string, string> } = {
		log,
		variables,
		mintFor: () => ({
			installationToken: async () => "ghs",
			fetch: async (url, init) => {
				const method = init?.method ?? "GET";
				const m = /repos\/([^/]+\/[^/]+)\/actions\/variables/.exec(url);
				if (!m) return new Response("{}", { status: 404 });
				if (over.writeStatus && over.writeStatus !== 200 && method !== "GET") return new Response("{}", { status: over.writeStatus });
				if (method === "DELETE") {
					variables.delete(m[1]);
					log.push(`delete-var ${m[1]}`);
					return new Response(null, { status: 204 });
				}
				const value = (JSON.parse(String(init?.body)) as { value: string }).value;
				variables.set(m[1], value);
				log.push(`${method === "POST" ? "create" : "update"}-var ${m[1]} ${value}`);
				return new Response(null, { status: 204 });
			},
		}),
		variableExists: async (repo) => variables.has(repo),
		cancelAndRerun: async (repo, id) => void log.push(`rerun ${repo}#${id}`),
		alert: async (repo, message) => void log.push(`alert ${repo}: ${message}`),
		onRouteChange: async (c) => void log.push(`flip ${c.repo} -> ${c.to}`),
	};
	return deps;
}

const desired = (over: Partial<DesiredRepo> = {}): DesiredRepo => ({ repo: REPO, visibility: "private", pinnedNode: B, minutes: { exhausted: true }, ...over });
const actual = (over: Partial<ActualState> = {}): ActualState => ({ groupAccess: {}, variables: {}, queuedRuns: [], onlineNodes: new Set([A, B]), ...over });

describe("executing the plan", () => {
	it("a re-pin: the variable moves to the new machine's label set FIRST, then runs queued on the old label are cancelled and re-run", async () => {
		const d = sim();
		d.variables.set(REPO, JSON.stringify(["self-hosted", "pags-mac-mini"]));
		const plan = planReconciliation([desired()], actual({ variables: { [REPO]: JSON.stringify(["self-hosted", "pags-mac-mini"]) }, queuedRuns: [{ repo: REPO, runId: 7, labels: ["self-hosted", "pags-mac-mini"] }] }));
		const out = await executePlan(plan, d);
		expect(d.log).toEqual([`update-var ${REPO} ${LABELS_B}`, `flip ${REPO} -> self-hosted`, `rerun ${REPO}#7`]);
		expect(out.filter((o) => o.op.op !== "add_repo_to_group").map((o) => o.status)).toEqual(["done", "done"]);
	});

	it("group operations are SKIPPED with the Free-plan reason — never pretended", async () => {
		const d = sim();
		const plan = planReconciliation([desired({ minutes: {} })], actual({ groupAccess: { [A]: [REPO] } }));
		const out = await executePlan(plan, d);
		const grouped = out.filter((o) => o.op.op === "remove_repo_from_group" || o.op.op === "add_repo_to_group");
		expect(grouped.length).toBeGreaterThan(0);
		for (const g of grouped) expect(g).toMatchObject({ status: "skipped", detail: GROUPLESS_REASON });
		expect(d.log.some((l) => l.includes("group"))).toBe(false);
	});

	it("going back to GitHub-hosted REMOVES the variable — never writes the plan's ubuntu-latest", async () => {
		const d = sim();
		d.variables.set(REPO, LABELS_B);
		const plan = planReconciliation([desired({ minutes: { usedPercent: 5 } })], actual({ variables: { [REPO]: LABELS_B } }));
		await executePlan(plan, d);
		expect(d.log).toEqual([`delete-var ${REPO}`, `flip ${REPO} -> github-hosted`]);
		expect(d.variables.size).toBe(0);
	});

	it("a write the App is not allowed (#1207) is 'denied', and the repo's queued runs are NOT re-dispatched onto a route that was not set", async () => {
		const d = sim({ writeStatus: 403 });
		const plan = planReconciliation([desired()], actual({ variables: { [REPO]: JSON.stringify(["self-hosted", "pags-mac-mini"]) }, queuedRuns: [{ repo: REPO, runId: 7, labels: ["self-hosted", "pags-mac-mini"] }] }));
		const out = await executePlan(plan, d);
		expect(out.find((o) => o.op.op === "set_variable")).toMatchObject({ status: "denied", detail: expect.stringMatching(/Variables: Read and write.*#1207/) });
		expect(out.find((o) => o.op.op === "cancel_and_redispatch")).toMatchObject({ status: "skipped" });
		expect(d.log).toEqual([]);
	});

	it("withoutGroupOps drops exactly the group operations, keeping the order of the rest", () => {
		const plan = planReconciliation([desired()], actual({ groupAccess: { [A]: [REPO] }, variables: { [REPO]: JSON.stringify(["self-hosted", "pags-mac-mini"]) } }));
		expect(plan.ops.some((o) => o.op === "add_repo_to_group")).toBe(true);
		expect(withoutGroupOps(plan).ops.map((o) => o.op)).toEqual(plan.ops.map((o) => o.op).filter((o) => !o.endsWith("_group")));
	});

	it("one repo's failure does not stop another's", async () => {
		const d = sim();
		const base = d.cancelAndRerun;
		d.cancelAndRerun = async (repo, id) => {
			if (repo === "o/bad") throw new Error("boom");
			return base(repo, id);
		};
		const plan = planReconciliation(
			[desired({ repo: "o/bad", minutes: {} }), desired({ repo: "o/good", minutes: {} })],
			actual({ variables: { "o/bad": LABELS_B, "o/good": LABELS_B }, queuedRuns: [{ repo: "o/bad", runId: 1, labels: ["self-hosted", "pags-dell"] }, { repo: "o/good", runId: 2, labels: ["self-hosted", "pags-dell"] }] }),
		);
		const out = await executePlan(plan, d);
		expect(out.filter((o) => o.status === "failed")).toHaveLength(1);
		expect(d.log).toContain("rerun o/good#2");
	});

	it("alerts are delivered, and every violation is alerted on even though the plan fixes it", async () => {
		const d = sim();
		const plan = planReconciliation([desired({ minutes: {} })], actual({ variables: { [REPO]: JSON.stringify(["self-hosted", "pags"]) } }));
		expect(plan.violations.map((v) => v.kind)).toContain("generic_route");
		await executePlan(plan, d);
		expect(d.log.some((l) => l.startsWith(`alert ${REPO}:`) && l.endsWith("(fixed)"))).toBe(true);
	});

	it("an offline pinned machine with minutes left: no variable write, the owner is alerted", async () => {
		const d = sim();
		const plan = planReconciliation([desired({ minutes: { usedPercent: 95 } })], actual({ onlineNodes: new Set() }));
		await executePlan(plan, d);
		expect(d.log).toEqual([expect.stringMatching(/^alert .*offline/)]);
	});

	it("idempotent: planning over the state the executor produced plans nothing", async () => {
		const d = sim();
		const plan = planReconciliation([desired()], actual());
		await executePlan(plan, d);
		const again = withoutGroupOps(planReconciliation([desired()], actual({ variables: { [REPO]: d.variables.get(REPO) } })));
		expect(again.ops).toEqual([]);
	});
});
