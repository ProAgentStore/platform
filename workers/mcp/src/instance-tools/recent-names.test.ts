/**
 * `account_activity` and `recent_instances` name one instance the same way (#923).
 *
 * `account_activity` used to hand back bare ids, so a caller scanning the whole roster had to join
 * it against `my_instances` to know which agent a row was. Both tools now carry `instanceId`,
 * `name` and `slug`; this drives both real handlers over one set of API answers — the shapes
 * `/my/activity` and `/my/instances` produce (pinned against each other in the API's
 * `instances-activity-names.test.ts`) — and holds them to agreeing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerRecentTools } from "./recent.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

const ACTIVITY = {
	asOf: 1,
	instances: [
		{ instanceId: "i-fas", name: "FAS FreeAppStore Coder", slug: "coder-repo", health: "working", queueDepth: 0, lastOutcome: { startedAt: 5, lastAliveAt: 6 } },
		{ instanceId: "i-op", name: "tmux Operator", slug: "tmux-operator", health: "working", queueDepth: 1, lastOutcome: { startedAt: 3, lastAliveAt: 4 } },
	],
};
const ROSTER = {
	instances: [
		{ id: "i-fas", name: "FAS FreeAppStore Coder", agentName: "Repo Coder", slug: "coder-repo", status: "active" },
		{ id: "i-op", name: "tmux Operator", slug: "tmux-operator", status: "paused" },
	],
};

function tools() {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = String(input);
		const body = url.includes("/my/activity") ? ACTIVITY : url.includes("/my/instances") ? ROSTER : { runs: [] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const handlers = new Map<string, Handler>();
	const env: McpEnv = { API_BASE: "https://api.test" };
	registerRecentTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read"] }),
		groups: new Set(),
	});
	const call = async (name: string) => JSON.parse((await (handlers.get(name) as Handler)({})).content[0].text) as { instances: Array<{ instanceId: string; name: string | null; slug: string | null }> };
	return { call };
}

afterEach(() => vi.unstubAllGlobals());

describe("account_activity and recent_instances agree on who an instance is (#923)", () => {
	it("account_activity carries name and slug beside every instanceId", async () => {
		const { instances } = await tools().call("account_activity");
		for (const row of instances) {
			expect(typeof row.name, row.instanceId).toBe("string");
			expect(typeof row.slug, row.instanceId).toBe("string");
		}
	});

	it("reports each instance under the same name and slug as recent_instances", async () => {
		const t = tools();
		const [activity, recent] = await Promise.all([t.call("account_activity"), t.call("recent_instances")]);
		const named = (rows: typeof activity.instances) => Object.fromEntries(rows.map((r) => [r.instanceId, { name: r.name, slug: r.slug }]));
		expect(recent.instances.length).toBe(2);
		expect(named(activity.instances)).toEqual(named(recent.instances));
	});
});
