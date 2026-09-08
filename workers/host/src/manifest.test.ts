import { describe, expect, it } from "vitest";
import { pinnedManifest, sanitizeManifestName } from "./manifest.js";

const BASE = JSON.stringify({ name: "ProAgentStore", short_name: "PAGS", start_url: "/console/", display: "standalone", scope: "/" });
const q = (o: Record<string, string>) => new URLSearchParams(o);

describe("pinnedManifest (#784)", () => {
	it("pins start_url and both names for a console instance path", () => {
		const { body, pinned } = pinnedManifest(BASE, q({ start: "/console/instances/inst-1", name: "Coder" }));
		expect(pinned).toBe(true);
		const m = JSON.parse(body);
		expect(m.start_url).toBe("/console/instances/inst-1");
		expect(m.short_name).toBe("Coder");
		expect(m.name).toBe("Coder — ProAgentStore");
		// Everything else is untouched.
		expect(m.display).toBe("standalone");
		expect(m.scope).toBe("/");
	});

	it("accepts a tab under the instance and nothing deeper or elsewhere", () => {
		expect(pinnedManifest(BASE, q({ start: "/console/instances/inst-1/chat" })).pinned).toBe(true);
		for (const start of [
			"/console/",
			"/console/agents/x",
			"/console/instances/",
			"/console/instances/inst-1/chat/extra",
			"/console/instances/inst-1?x=1",
			"https://evil.example/console/instances/inst-1",
			"//evil.example/console/instances/inst-1",
			"/console/instances/../../admin",
			"/console/instances/inst 1",
		]) {
			const r = pinnedManifest(BASE, q({ start }));
			expect(r.pinned, start).toBe(false);
			expect(r.body, start).toBe(BASE);
		}
	});

	it("returns the default manifest byte-for-byte when there is no query", () => {
		expect(pinnedManifest(BASE, new URLSearchParams())).toEqual({ body: BASE, pinned: false });
	});

	it("keeps the default names when the name is missing or empty after cleaning", () => {
		const m = JSON.parse(pinnedManifest(BASE, q({ start: "/console/instances/inst-1", name: " " })).body);
		expect(m.short_name).toBe("PAGS");
		expect(m.name).toBe("ProAgentStore");
	});

	it("bounds and cleans the name, and never lets it become anything but a JSON string", () => {
		expect(sanitizeManifestName("  My  Agent\n ")).toBe("My Agent");
		expect(sanitizeManifestName("a\u0007bcd")).toBe("abcd");
		expect(sanitizeManifestName("x".repeat(80))?.length).toBe(30);
		expect(sanitizeManifestName("")).toBeNull();
		expect(sanitizeManifestName(null)).toBeNull();
		const evil = '"},"start_url":"https://evil.example/"';
		const m = JSON.parse(pinnedManifest(BASE, q({ start: "/console/instances/inst-1", name: evil })).body);
		expect(m.start_url).toBe("/console/instances/inst-1");
		expect(m.short_name).toBe(evil.slice(0, 30));
	});
});
