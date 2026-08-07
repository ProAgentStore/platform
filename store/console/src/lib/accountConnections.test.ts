import { describe, expect, it } from "vitest";
import {
	accountConnections,
	connectionSummary,
	disconnectedMessage,
	disconnectPromptFor,
	type ConnectorEntry,
} from "./accountConnections";

const entry = (over: Partial<ConnectorEntry> = {}): ConnectorEntry => ({
	id: "google_drive",
	label: "Google Drive",
	auth: "oauth",
	grantModel: "instance-resource",
	configured: true,
	connected: true,
	account: "me@example.com",
	connectedAt: "2026-08-01T00:00:00Z",
	reach: { grants: 0, instances: 0 },
	flow: { start: "/v1/drive/google/start", disconnect: "/v1/drive/google" },
	...over,
});

describe("accountConnections — which catalog rows a person can act on", () => {
	it("keeps connectors that hold a credential and can be connected here", () => {
		const rows = accountConnections([entry(), entry({ id: "gmail", label: "Gmail", grantModel: "user", reach: null })]);
		expect(rows.map((r) => r.id)).toEqual(["gmail", "google_drive"]);
	});

	it("drops a connector this deployment cannot connect — that is operator news, not owner news", () => {
		expect(accountConnections([entry({ configured: false })])).toEqual([]);
	});

	it("drops a connector that holds no credential — a relay tool has nothing to connect", () => {
		expect(accountConnections([entry({ id: "tmux", connected: null })])).toEqual([]);
	});

	it("drops a connector the server named no flow for, rather than rendering dead buttons", () => {
		expect(accountConnections([entry({ flow: null })])).toEqual([]);
	});

	it("puts what you have connected first — that is what you came to check", () => {
		const rows = accountConnections([
			entry({ id: "a", label: "Aardvark", connected: false }),
			entry({ id: "z", label: "Zebra", connected: true }),
		]);
		expect(rows.map((r) => r.id)).toEqual(["z", "a"]);
	});
});

describe("connectionSummary — the row says how far the connection reaches", () => {
	it("names the account", () => {
		expect(connectionSummary(entry())).toBe("connected as me@example.com");
	});

	it("adds the blast radius when grants exist, so it is visible without clicking disconnect", () => {
		expect(connectionSummary(entry({ reach: { grants: 5, instances: 2 } }))).toBe(
			"connected as me@example.com · 5 folder grants on 2 agents",
		);
	});

	it("singularises, because '1 folder grants on 1 agents' reads as a bug", () => {
		expect(connectionSummary(entry({ reach: { grants: 1, instances: 1 } }))).toContain("1 folder grant on 1 agent");
	});

	it("says nothing about grants for a connector whose reach is not grants", () => {
		expect(connectionSummary(entry({ id: "gmail", grantModel: "user", reach: null }))).toBe("connected as me@example.com");
	});

	it("does not invent an account label it was not given", () => {
		expect(connectionSummary(entry({ account: null }))).toBe("connected");
	});

	it("is plain about not being connected", () => {
		expect(connectionSummary(entry({ connected: false }))).toBe("not connected");
	});
});

describe("disconnectPromptFor — what the click is about to destroy, before the click", () => {
	it("quotes the revoked grants for a grant-holding connector", () => {
		const msg = disconnectPromptFor(entry({ reach: { grants: 4, instances: 2 } }));
		expect(msg).toContain("4 folder grants");
		expect(msg).toContain("2 agents");
	});

	// The old copy said "Agents will no longer be able to read your inbox" — plural, vague, and
	// silent about the permission that survives and is re-armed by reconnecting.
	it("says what a user-scoped disconnect does NOT clear, rather than implying a cleanup", () => {
		const msg = disconnectPromptFor(entry({ id: "gmail", label: "Gmail", grantModel: "user", reach: null }));
		expect(msg).toContain("Every agent loses access immediately");
		expect(msg).toContain("is NOT cleared");
		expect(msg).toContain("reconnecting Gmail restores it");
	});
});

describe("disconnectedMessage", () => {
	it("reports what was revoked", () => {
		expect(disconnectedMessage(entry(), { grants: 3, instances: 1 })).toBe(
			"Google Drive disconnected. Revoked 3 folder grants across 1 agent.",
		);
	});

	it("stays quiet when nothing was revoked — a zero is not worth a sentence", () => {
		expect(disconnectedMessage(entry(), { grants: 0, instances: 0 })).toBe("Google Drive disconnected.");
		expect(disconnectedMessage(entry())).toBe("Google Drive disconnected.");
	});
});
