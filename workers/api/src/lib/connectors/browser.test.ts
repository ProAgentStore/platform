import { describe, expect, it } from "vitest";
import { getRegistryTool, registryConnectorGroups, registryToolNameSet, runRegistryTool } from "../tool-registry.js";
import { browserToolsEnabled } from "./browser.js";
import type { Env } from "../../types.js";

/** Env with only the experimental flag set (no DB → any consent lookup is irrelevant here). */
const envFlag = (on: boolean) => ({ BROWSER_TOOLS_ENABLED: on ? "true" : undefined }) as unknown as Env;

/** Env with the flag on AND a consent lookup that returns `granted` for every write. */
const envConsent = (granted: boolean, flagOn = true) =>
	({
		BROWSER_TOOLS_ENABLED: flagOn ? "1" : undefined,
		DB: { prepare() { return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } }; } },
	}) as unknown as Env;

describe("browser connector (#103)", () => {
	it("registers browser_navigate / browser_snapshot / browser_act with correct scopes", () => {
		const names = registryToolNameSet();
		expect(names.has("browser_navigate")).toBe(true);
		expect(names.has("browser_snapshot")).toBe(true);
		expect(names.has("browser_act")).toBe(true);
		// Navigate + act mutate the live page as the signed-in user → write (consent-gated).
		expect(getRegistryTool("browser_navigate")?.scope).toBe("write");
		expect(getRegistryTool("browser_act")?.scope).toBe("write");
		// Snapshot only reads the page → read.
		expect(getRegistryTool("browser_snapshot")?.scope).toBe("read");
	});

	it("groups the three tools under the browser connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "browser");
		expect(grp?.tools).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]));
	});

	it("browserToolsEnabled reads the flag: 1/true → on; unset/empty/other → off", () => {
		expect(browserToolsEnabled({ BROWSER_TOOLS_ENABLED: "1" } as Env)).toBe(true);
		expect(browserToolsEnabled({ BROWSER_TOOLS_ENABLED: "true" } as Env)).toBe(true);
		expect(browserToolsEnabled({ BROWSER_TOOLS_ENABLED: "" } as Env)).toBe(false);
		expect(browserToolsEnabled({ BROWSER_TOOLS_ENABLED: "yes" } as Env)).toBe(false);
		expect(browserToolsEnabled({} as Env)).toBe(false);
	});

	it("is inert when the experimental flag is off — even a READ tool fails closed", async () => {
		const r = await runRegistryTool("browser_snapshot", { env: envFlag(false), userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/experimental|not enabled/i);
	});

	it("a WRITE browser tool without consent is blocked before touching the runner (fail-closed, #90)", async () => {
		const r = await runRegistryTool("browser_navigate", { env: envConsent(false), userId: "u1", instanceId: "i1" }, { url: "https://example.com" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
	});

	it("with the flag on + write consent + no runner connected → a clear 'run pags up' error, no throw", async () => {
		const r = await runRegistryTool("browser_navigate", { env: envConsent(true), userId: "u1", instanceId: "i1" }, { url: "https://example.com" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/runner|pags up/i);
	});

	it("browser_snapshot with the flag on but no runner → 'run pags up' (read needs only the runner)", async () => {
		const r = await runRegistryTool("browser_snapshot", { env: envConsent(true), userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/runner|pags up/i);
	});
});
