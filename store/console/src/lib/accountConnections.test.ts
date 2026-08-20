import { describe, expect, it } from "vitest";
import {
	accountConnections,
	connectionSummary,
	disconnectedMessage,
	disconnectPromptFor,
	accountRows,
	needsPerAgentChoice,
	needsReconnect,
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

// ── #713/#714: a connection can be connected AND short of scope ──────────────

describe("needsReconnect", () => {
	const gmail = (over: Partial<ConnectorEntry> = {}): ConnectorEntry =>
		({
			id: "gmail",
			label: "Gmail",
			auth: "oauth",
			grantModel: "user",
			configured: true,
			connected: true,
			account: "me@example.test",
			connectedAt: "2026-01-01",
			reach: null,
			flow: { start: "/v1/email/google/start", disconnect: "/v1/email/google" },
			scopes: { read: true, write: true },
			...over,
		}) as ConnectorEntry;

	it("is false for a connection that holds everything declared", () => {
		expect(needsReconnect(gmail({ missingScopes: [] }))).toBe(false);
	});

	it("is true when the grant provably lacks a declared scope", () => {
		expect(needsReconnect(gmail({ missingScopes: ["https://www.googleapis.com/auth/gmail.send"] }))).toBe(true);
	});

	it("is true when the grant predates recording AND the connector can write", () => {
		// The migration-0133 population. Unknown is treated as stale: one unnecessary reconnect
		// beats an agent finding out as a provider 403 halfway through a task.
		expect(needsReconnect(gmail({ missingScopes: null }))).toBe(true);
	});

	it("is FALSE for an unrecorded grant on a read-only connector — nothing to add", () => {
		// Drive/WorkDrive. Flagging them would be a reconnect that changes nothing.
		expect(needsReconnect(gmail({ missingScopes: null, scopes: { read: true, write: false } }))).toBe(false);
	});

	it("is false for a connector that is not connected at all", () => {
		expect(needsReconnect(gmail({ connected: false, missingScopes: null }))).toBe(false);
	});
});

describe("connectionSummary — scope shortfall", () => {
	const base: ConnectorEntry = {
		id: "gmail",
		label: "Gmail",
		auth: "oauth",
		grantModel: "user",
		configured: true,
		connected: true,
		account: "me@example.test",
		connectedAt: "2026-01-01",
		reach: null,
		flow: { start: "/s", disconnect: "/d" },
		scopes: { read: true, write: true },
	} as ConnectorEntry;

	it("names the shortfall and the remedy on the row itself", () => {
		expect(connectionSummary({ ...base, missingScopes: null })).toBe(
			"connected as me@example.test · read-only — reconnect to allow sending",
		);
	});

	it("says nothing extra once the grant is complete", () => {
		expect(connectionSummary({ ...base, missingScopes: [] })).toBe("connected as me@example.test");
	});

	it("keeps the grant counts a file connector reports, shortfall or not", () => {
		const drive = { ...base, id: "google_drive", label: "Google Drive", grantModel: "instance-resource" as const, reach: { grants: 2, instances: 1 }, scopes: { read: true, write: false }, missingScopes: null };
		expect(connectionSummary(drive)).toBe("connected as me@example.test · 2 folder grants on 1 agent");
	});
});

// ── #715: several accounts of the same kind ─────────────────────────────────

describe("accountRows", () => {
	const withAccounts = (accounts: ConnectorEntry["accounts"]): ConnectorEntry =>
		({
			id: "gmail",
			label: "Gmail",
			auth: "oauth",
			grantModel: "user",
			configured: true,
			connected: true,
			account: null,
			connectedAt: null,
			reach: null,
			flow: { start: "/s", disconnect: "/d" },
			scopes: { read: true, write: true },
			accounts,
		}) as ConnectorEntry;

	it("names each account by its address", () => {
		const rows = accountRows(withAccounts([
			{ accountId: "a@x.test", label: "a@x.test", connectedAt: null, missingScopes: [] },
			{ accountId: "b@x.test", label: "b@x.test", connectedAt: null, missingScopes: [] },
		]));
		expect(rows.map((r) => r.name)).toEqual(["a@x.test", "b@x.test"]);
		expect(rows.every((r) => r.note === null)).toBe(true);
	});

	it("falls back to the id, then to a phrase, so every account can be disconnected", () => {
		// An account with no name is still an account. If it cannot be named it cannot be removed,
		// which would strand a credential the owner can see but not revoke.
		const rows = accountRows(withAccounts([
			{ accountId: "abc", label: null, connectedAt: null, missingScopes: [] },
			{ accountId: "", label: "   ", connectedAt: null, missingScopes: [] },
		]));
		expect(rows.map((r) => r.name)).toEqual(["abc", "unnamed connection"]);
	});

	it("marks the accounts that are short of scope, per account", () => {
		// The whole point of doing this per account: one mailbox can be send-capable while
		// another, connected earlier, is not.
		const rows = accountRows(withAccounts([
			{ accountId: "new@x.test", label: "new@x.test", connectedAt: null, missingScopes: [] },
			{ accountId: "old@x.test", label: "old@x.test", connectedAt: null, missingScopes: null },
		]));
		expect(rows[0].note).toBeNull();
		expect(rows[1].note).toBe("read-only — reconnect to allow sending");
	});
});

describe("needsPerAgentChoice", () => {
	const entry = (n: number): ConnectorEntry =>
		({
			id: "gmail",
			label: "Gmail",
			auth: "oauth",
			grantModel: "user",
			configured: true,
			connected: n > 0,
			account: null,
			connectedAt: null,
			reach: null,
			flow: { start: "/s", disconnect: "/d" },
			accounts: Array.from({ length: n }, (_, i) => ({ accountId: `a${i}`, label: `a${i}`, connectedAt: null, missingScopes: [] })),
		}) as ConnectorEntry;

	it("is false for none or one — nobody who never adds a second configures anything", () => {
		expect(needsPerAgentChoice(entry(0))).toBe(false);
		expect(needsPerAgentChoice(entry(1))).toBe(false);
	});

	it("is true from two, which is when an agent has a decision to make", () => {
		expect(needsPerAgentChoice(entry(2))).toBe(true);
		expect(needsPerAgentChoice(entry(5))).toBe(true);
	});

	it("is false when the field is absent entirely, for a caller written before #715", () => {
		expect(needsPerAgentChoice({ id: "x", label: "X" } as ConnectorEntry)).toBe(false);
	});
});

describe("the summary line does not answer for accounts it cannot see", () => {
	const gmail = (accounts: ConnectorEntry["accounts"]): ConnectorEntry =>
		({
			id: "gmail",
			label: "Gmail",
			auth: "oauth",
			grantModel: "user",
			configured: true,
			connected: true,
			account: null,
			connectedAt: null,
			reach: null,
			flow: { start: "/s", disconnect: "/d" },
			scopes: { read: true, write: true },
			// With several accounts the route sends null here on purpose — no single answer exists.
			missingScopes: null,
			accounts,
		}) as ConnectorEntry;

	it("stays quiet with several accounts, even when every one of them CAN send", () => {
		// The reported bug: the row said "read-only — reconnect to allow sending" above a list in
		// which each account was already stating its own verdict, and said it regardless of them.
		const entry = gmail([
			{ accountId: "a@x.test", label: "a@x.test", connectedAt: null, missingScopes: [] },
			{ accountId: "b@x.test", label: "b@x.test", connectedAt: null, missingScopes: [] },
		]);
		expect(needsReconnect(entry)).toBe(false);
		expect(connectionSummary(entry)).toBe("connected");
	});

	it("still lets each account state its own verdict underneath", () => {
		const entry = gmail([
			{ accountId: "ok@x.test", label: "ok@x.test", connectedAt: null, missingScopes: [] },
			{ accountId: "old@x.test", label: "old@x.test", connectedAt: null, missingScopes: null },
		]);
		expect(accountRows(entry).map((r) => r.note)).toEqual([null, "read-only — reconnect to allow sending"]);
	});

	it("still warns on the summary when there is exactly ONE account short of scope", () => {
		const entry = gmail([{ accountId: "a@x.test", label: "a@x.test", connectedAt: null, missingScopes: null }]);
		expect(needsReconnect(entry)).toBe(true);
	});
});
