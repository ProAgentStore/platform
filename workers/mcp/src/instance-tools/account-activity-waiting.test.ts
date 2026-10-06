/**
 * account_activity says which agents are blocked waiting for the OWNER to enter a secret (#934).
 * Only a person can unblock those, so an orchestrator reading the account must be able to see them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerRecentTools } from "./recent.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function accountActivity(answers: { activity: unknown; secure: unknown | "fail" }) {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = String(input);
		const body = url.includes("/my/secure-inputs") ? answers.secure : answers.activity;
		if (body === "fail") return new Response("boom", { status: 500 });
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
	return (handlers.get("account_activity") as Handler)({}).then((r) => JSON.parse(r.content[0].text) as Record<string, unknown>);
}

afterEach(() => vi.unstubAllGlobals());

const ACTIVITY = { asOf: 1, instances: [{ instanceId: "i1", name: "Coder", slug: "coder-repo", health: "waiting", queueDepth: 0 }] };

describe("account_activity waitingOnOwner (#934)", () => {
	it("carries the instances waiting on the owner, beside the activity rows", async () => {
		const waiting = [{ instanceId: "i2", pending: 1, requestId: "req-1", label: "Firebase auth code" }];
		const out = await accountActivity({ activity: ACTIVITY, secure: { instances: waiting } });
		expect(out.instances).toEqual(ACTIVITY.instances);
		expect(out.waitingOnOwner).toEqual(waiting);
	});

	it("is an empty list, not a failure, when that read fails", async () => {
		const out = await accountActivity({ activity: ACTIVITY, secure: "fail" });
		expect(out.instances).toEqual(ACTIVITY.instances);
		expect(out.waitingOnOwner).toEqual([]);
	});
});
