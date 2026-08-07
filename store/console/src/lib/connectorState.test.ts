import { describe, expect, it } from "vitest";
import { connectorState, showsConnector } from "./connectorState";

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
