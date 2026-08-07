import { describe, expect, it } from "vitest";
import { connectorState, disconnectPrompt, showsConnector, showsFileConnector } from "./connectorState";

describe("connectorState — an inert connector is a state, not a failure (#353)", () => {
	it("names the deployment gap separately from 'you haven't connected it'", () => {
		// The two produce the same `connected:false` and need opposite treatment: one is a setup
		// step the owner can take, the other is an operator's unfinished work they cannot.
		expect(connectorState({ connected: false, configured: false })).toBe("unavailable");
		expect(connectorState({ connected: false, configured: true })).toBe("disconnected");
		expect(connectorState({ connected: true, configured: true })).toBe("connected");
	});

	it("keeps 'not answered yet' apart from 'not connected'", () => {
		expect(connectorState(null)).toBe("unknown");
		expect(connectorState(undefined)).toBe("unknown");
	});

	// A connected flag with configured:false should not be reported as usable — the deployment
	// has no client to refresh the grant with, so trust the flag that says so.
	it("treats an unconfigured deployment as unavailable even if a stale grant says connected", () => {
		expect(connectorState({ connected: true, configured: false })).toBe("unavailable");
	});
});

describe("showsConnector", () => {
	it("shows only what the person reading the page can act on", () => {
		expect(showsConnector({ connected: false, configured: true })).toBe(true);
		expect(showsConnector({ connected: true, configured: true })).toBe(true);
		expect(showsConnector({ connected: false, configured: false })).toBe(false);
	});

	// Zoho WorkDrive, in production: `{connected:false, configured:false}` on every instance.
	// It used to render a red warning plus a dead row with no button; it now renders nothing.
	it("renders nothing for a connector that has never been configured", () => {
		expect(showsConnector({ connected: false, configured: false })).toBe(false);
	});

	it("waits for the answer rather than flashing an unconnected row", () => {
		expect(showsConnector(null)).toBe(false);
	});
});

describe("disconnectPrompt — the blast radius, before the click (#357)", () => {
	it("names how many grants on how many agents will be revoked", () => {
		const msg = disconnectPrompt("Google Drive", { grants: 4, instances: 2 });
		expect(msg).toContain("REVOKES 4 folder grants across 2 agents");
		expect(msg).toContain("Reconnecting will not bring them back");
	});

	it("says what survives, so the prompt is not only a threat", () => {
		expect(disconnectPrompt("Google Drive", { grants: 1, instances: 1 })).toContain(
			"Documents already imported stay",
		);
	});

	it("singularizes, because '1 folder grants across 1 agents' reads as a bug", () => {
		expect(disconnectPrompt("Zoho WorkDrive", { grants: 1, instances: 1 })).toContain(
			"REVOKES 1 folder grant across 1 agent.",
		);
	});

	// The reach is fetched fresh at click time; if that read failed we still disconnect, and the
	// prompt must not invent a number it does not have.
	it("claims no revocation when the reach is unknown or empty", () => {
		for (const reach of [undefined, null, { grants: 0, instances: 0 }]) {
			const msg = disconnectPrompt("Google Drive", reach);
			expect(msg).toContain("No agent currently holds a Google Drive folder grant");
			expect(msg).not.toContain("REVOKES");
		}
	});
});

describe("showsFileConnector — the per-AGENT half of the answer (#352)", () => {
	const connected = { connected: true, configured: true };
	const operator = [{ id: "google_drive", allowed: false, reason: "no_knowledge" }];
	const reader = [{ id: "google_drive", allowed: true, reason: "knowledge" }];

	// One account connection, two agents, two answers. This is the state the issue is named for:
	// #355 stopped rendering the panel until Drive was connected, and connecting it once put the
	// panel back on every instance the owner has — terminal Operators included.
	it("hides the panel from an agent that cannot use what a folder grant would import", () => {
		expect(showsFileConnector(connected, operator, "google_drive")).toBe(false);
		expect(showsFileConnector(connected, reader, "google_drive")).toBe(true);
	});

	it("still requires the account connection — a grant against nothing is a dead row", () => {
		expect(showsFileConnector({ connected: false, configured: true }, reader, "google_drive")).toBe(false);
		expect(showsFileConnector(null, reader, "google_drive")).toBe(false);
	});

	// Nothing here fails closed on purpose: there is no exposure to prevent (the grant routes are
	// owner-scoped and the agent has no Drive tool), so an unreachable new endpoint must not remove
	// a working control.
	it("falls back to showing the panel when the policy is unavailable", () => {
		expect(showsFileConnector(connected, null, "google_drive")).toBe(true);
		expect(showsFileConnector(connected, [], "google_drive")).toBe(true);
	});
});
