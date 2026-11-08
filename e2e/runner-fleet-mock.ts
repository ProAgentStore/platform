import type { Page } from "@playwright/test";

/**
 * Five machines on one account, one of them this instance's pin (#1594). Every machine carries a resource
 * warning and an out-of-date CLI, so a spec can tell the pinned machine's own lines from the others'.
 * Routes registered here win over `mockSignedInConsole`'s fallback because they are added after it.
 */
export const FLEET_NODES = ["Mac-mini.local", "Air.local", "Studio.local", "Pi.local", "Old-laptop.local"];
export const FLEET_PIN = FLEET_NODES[0];

export async function installFleetRoutes(page: Page, opts: { pin?: string | null; onPin?: (body: unknown) => void } = {}) {
	let pin = opts.pin === undefined ? FLEET_PIN : opts.pin;
	const detail = () => FLEET_NODES.map((node) => ({ node, connected: node === pin, nodeOnline: node !== "Old-laptop.local" }));
	const json = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
	await page.route("**/v1/instances/inst-1/runtime/status", (route) => route.fulfill(json({ runtime: { instanceId: "inst-1", status: "online", runnerNode: pin }, relay: { connected: true, runnerNode: pin, live: true } })));
	await page.route("**/v1/instances/inst-1/runner-node", async (route) => {
		if (route.request().method() === "PUT") {
			const body = route.request().postDataJSON();
			opts.onPin?.(body);
			pin = body.runnerNode;
			return route.fulfill(json({ runnerNode: pin, attachment: { node: pin, attached: true } }));
		}
		return route.fulfill(json({ runnerNode: pin, nodes: FLEET_NODES, nodesDetail: detail(), resolvedNode: null }));
	});
	await page.route("**/v1/terminals/nodes", (route) =>
		route.fulfill(json({
			nodes: FLEET_NODES.map((node, i) => ({
				node,
				machineId: `machine-${i}`,
				aka: [],
				placement: "local",
				runnerVersion: "0.4.40",
				lastSeenAt: "2026-08-12T07:44:00Z",
				connected: node !== "Old-laptop.local",
				instances: node === pin ? [{ instanceId: "inst-1", connected: true, bound: true }] : [],
				resources: { load1: 5, cpus: 4, loadPerCpu: 1.25, memUsedPct: 40, platform: "darwin", sampledAt: "2026-08-12T07:44:00Z", activeSessions: 1, recommendedMaxSessions: 4, disk: null, runner: null, warnings: [`Crash loop on ${node}: restarted 9 times`] },
				runnerBehind: ["x"],
				sessions: [],
			})),
		})),
	);
}
