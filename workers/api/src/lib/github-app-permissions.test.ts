/** #1207 — the TypeScript list equals the script's, and every refusal names ALL the permissions to grant. */
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs module outside this package's tsconfig
import { REQUIRED_APP_PERMISSIONS as SCRIPT_LIST } from "../../../../scripts/lib/github-app-permissions.mjs";
import { mintRunnerToken, syncRunnerLabels } from "./actions-runner-provision.js";
import { GRANT_ALL_HINT, REQUIRED_APP_PERMISSIONS } from "./github-app-permissions.js";
import { ciRunnersForForget } from "./runner-forget-ci.js";
import { readOrgMinutes, syncRepoRoutes } from "./runner-routing-sync.js";

const denied = (status = 403) => ({ installationToken: async () => "ghs", fetch: async () => new Response("{}", { status }) });
const ALL_THREE = [/Self-hosted runners: Read and write/, /Variables: Read and write/, /Administration: Read-only/, /#1207/];

describe("one list of required permissions", () => {
	it("the worker's mirror equals the script's, key for key and level for level", () => {
		const script = Object.fromEntries(Object.entries(SCRIPT_LIST as Record<string, { level: string }>).map(([k, v]) => [k, v.level]));
		expect(REQUIRED_APP_PERMISSIONS).toEqual(script);
	});
});

describe("every GitHub refusal tells the operator everything to grant", () => {
	it("the hint names all three, and where to check", () => {
		for (const re of ALL_THREE) expect(GRANT_ALL_HINT).toMatch(re);
		expect(GRANT_ALL_HINT).toContain("check-github-app-permissions");
	});

	it("minting a registration token", async () => {
		const err = await mintRunnerToken({ org: "o" }, "registration", denied()).catch((e) => e as Error);
		for (const re of ALL_THREE) expect((err as Error).message).toMatch(re);
		expect((err as Error).message).toMatch(/needs "Self-hosted runners: Read and write" \(organization\)/); // the specific one is still first
	});

	it("a repo-scoped mint keeps its own specific permission and still lists all three", async () => {
		const err = (await mintRunnerToken({ repo: "o/r" }, "registration", denied()).catch((e) => e)) as Error;
		expect(err.message).toMatch(/"Administration: Read and write" \(repository\)/);
		for (const re of ALL_THREE) expect(err.message).toMatch(re);
	});

	it("refreshing a runner's labels", async () => {
		const err = (await syncRunnerLabels({ org: "o" }, "r", [], denied()).catch((e) => e)) as Error;
		for (const re of ALL_THREE) expect(err.message).toMatch(re);
	});

	it("listing the CI runners a forget would orphan", async () => {
		const r = await ciRunnersForForget(["mac-mini"], ["o"], denied());
		for (const re of ALL_THREE) expect(r.unreadable[0].detail).toMatch(re);
	});

	it("reading the org's billing usage", async () => {
		const m = await readOrgMinutes("o", denied(), { includedMinutes: 1000 });
		expect(m.source).toBe("unreadable");
		for (const re of ALL_THREE) expect((m as { detail: string }).detail).toMatch(re);
	});

	it("writing the PAGS_RUNNER variable", async () => {
		const get = new Response(JSON.stringify({ value: null }), { status: 404 });
		const deps = {
			installationToken: async () => "ghs",
			onFlip: async () => {},
			fetch: async (url: string, init?: RequestInit) => {
				if (url.includes("billing/usage")) return Response.json({ usageItems: [{ product: "Actions", unitType: "Minutes", sku: "Actions Linux", quantity: 990 }] });
				if (init?.method && init.method !== "GET") return new Response("{}", { status: 403 });
				return get.clone();
			},
		};
		const [r] = await syncRepoRoutes([{ repo: "o/r", visibility: "private", pinnedNode: "mac-mini" }], new Set(["mac-mini"]), deps, { includedMinutes: 1000 });
		expect(r.status).toBe("denied");
		for (const re of ALL_THREE) expect((r as { detail: string }).detail).toMatch(re);
	});
});
