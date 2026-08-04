import { describe, expect, it } from "vitest";
import { agentCapabilities } from "./agent-capabilities.js";
import { optionsFor } from "./surface-options.js";

/**
 * The Overseer is the IN-AGENT cross-repo coordinator: it reads every repo on the instance and
 * delegates into their engines via `drive_claude`. That is precisely the layer the platform
 * supervision graph replaces, so a Repo Coder — one repo, driven BY its Lead — must not carry it.
 *
 * Its UI is already gone from the Coding tab, but `POST /:id/coding/overseer` stayed reachable
 * with only an ownership check, so the second layer was still hanging off a leaf agent.
 */
const declared = (caps: Record<string, unknown>) => ({ slug: "coder-repo", category: "code", config: JSON.stringify({ capabilities: caps }) });

describe("Overseer availability follows the declared surface options", () => {
	it("is OFF for a Repo Coder (drive:false)", () => {
		const caps = agentCapabilities(declared({ surfaces: ["coding"], surfaceOptions: { coding: { drive: false, repos: "single" } } }));
		expect(optionsFor(caps, "coding")?.drive).toBe(false);
	});

	it("stays ON for the original Coder, which legitimately drives its own engines", () => {
		const caps = agentCapabilities({ slug: "coder", category: "code", config: JSON.stringify({ capabilities: { surfaces: ["coding"] } }) });
		expect(optionsFor(caps, "coding")?.drive).toBe(true);
	});

	it("stays ON when an agent declares coding with no options — absent must not disable it", () => {
		const caps = agentCapabilities(declared({ surfaces: ["coding"] }));
		expect(optionsFor(caps, "coding")?.drive).toBe(true);
	});

	it("is not applicable to an agent with no coding surface at all", () => {
		const caps = agentCapabilities({ slug: "coder-lead", category: "code", config: JSON.stringify({ capabilities: { surfaces: [] } }) });
		expect(optionsFor(caps, "coding")).toBeNull();
	});
});
