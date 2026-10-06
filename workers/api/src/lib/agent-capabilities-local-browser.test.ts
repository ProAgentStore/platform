/**
 * `runtime: "local_browser"` and its `localBrowser` block (#945): declarable through the same
 * sanitizer as the other power fields, refused when invalid, resolved with defaults — and never
 * Coding-tab or repository semantics.
 */
import { describe, expect, it } from "vitest";
import { agentCapabilities, localBrowserDenial, sanitizeDeclaredCapabilities } from "./agent-capabilities";

const agent = (capabilities: unknown) => ({ slug: "job-search-scout", category: "research", config: JSON.stringify({ capabilities }) });

describe("declaring local browser research", () => {
	it("accepts the runtime and keeps the block for the merged-block check", () => {
		const d = sanitizeDeclaredCapabilities({ surfaces: [], runtime: "local_browser", localBrowser: { engines: ["codex"] } });
		expect(d).toEqual({ surfaces: [], runtime: "local_browser", localBrowser: { engines: ["codex"] } });
		expect(localBrowserDenial(d)).toBeNull();
	});

	it("refuses the block on any other runtime, and an invalid block, with the reason", () => {
		expect(localBrowserDenial({ runtime: "coding", localBrowser: {} })).toMatch(/requires capabilities.runtime "local_browser" — but capabilities.runtime is "coding"/);
		expect(localBrowserDenial({ runtime: null, localBrowser: {} })).toMatch(/runtime is null/);
		expect(localBrowserDenial({ runtime: "local_browser", localBrowser: { limits: { maxMinutes: 999 } } })).toMatch(/maxMinutes/);
		expect(localBrowserDenial({ runtime: "local_browser" })).toBeNull();
	});
});

describe("resolving it", () => {
	it("fills defaults for a local_browser agent and grants no Coding surface or workflow", () => {
		const caps = agentCapabilities(agent({ surfaces: [], runtime: "local_browser" }));
		expect(caps).toMatchObject({ surfaces: [], runtime: "local_browser", workflow: null, localBrowser: { engines: ["claude", "codex"], mode: "research_only", subscriptionOnly: true } });
	});

	it("does not resolve the block on an agent of another runtime, even if one is stored", () => {
		expect(agentCapabilities(agent({ surfaces: ["coding"], runtime: "coding", localBrowser: {} })).localBrowser).toBeUndefined();
	});

	it("resolves a stored block that no longer validates to nothing, not to defaults", () => {
		expect(agentCapabilities(agent({ surfaces: [], runtime: "local_browser", localBrowser: { engines: ["gemini"] } })).localBrowser).toBeUndefined();
	});
});
