/** Browser verification card (#1031): what it sends, and how a machine reads. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BrowserVerificationSettings, changedFields, machineLine } from "./browserVerification";

const saved: BrowserVerificationSettings = { enabled: false, runtime: "pinned", fallback: "wait", waitLimitMinutes: 60, takeover: "prompt", allowMobile: true };

describe("browser verification card", () => {
	it("sends only the fields changed", () => {
		expect(changedFields(saved, { ...saved, enabled: true, allowMobile: false })).toEqual({ enabled: true, allowMobile: false });
		expect(changedFields(saved, saved)).toEqual({});
	});

	it("reads a connected machine whose runner does not answer as NOT eligible, with the facts apart", () => {
		const line = machineLine({ node: "mac", pinned: true, heartbeat: { lastSeenAt: null, fresh: true }, attached: true, health: { state: "timeout" }, runnerVersion: "0.4.114", eligible: false, reason: "unhealthy" });
		expect(line).toEqual({ verdict: "connected, runner not answering", good: false, facts: "heartbeat fresh · attached (connection only) · health timeout · CLI 0.4.114" });
		expect(machineLine({ node: "dell", pinned: false, heartbeat: { lastSeenAt: null, fresh: true }, attached: true, health: { state: "ok" }, runnerVersion: null, eligible: true }).verdict).toBe("eligible");
	});

	// UI/MCP parity: the card edits exactly the fields MCP's set_instance_browser_verification sets.
	it("edits the same six settings MCP does, through the same route", () => {
		const mcp = readFileSync(join(__dirname, "../../../../workers/mcp/src/instance-tools/browser-verification.ts"), "utf8");
		const card = readFileSync(join(__dirname, "../tabs/settings/BrowserVerificationSection.tsx"), "utf8");
		for (const field of Object.keys(saved)) {
			expect(mcp, `MCP sets ${field}`).toContain(`patch.${field} =`);
			expect(card, `the card edits ${field}`).toMatch(new RegExp(`set\\(\\{ ${field}:|form\\.${field}`));
		}
		for (const route of ["/browser-verification`", "/browser-verification/runtimes`"]) {
			expect(mcp).toContain(route);
			expect(card).toContain(route);
		}
	});
});
