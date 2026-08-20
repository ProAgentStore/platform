import { describe, expect, it } from "vitest";
import { pinnedAccountsFrom, resolveConnectorAccount, type ConnectorAccount } from "./connector-accounts.js";

/**
 * The resolver decides which mailbox an agent speaks as (#715). Almost every test here is about
 * what it does when the answer is NOT obvious, because that is the whole design: sending mail
 * from the wrong identity reaches a real person under a name the owner did not choose, and no
 * click undoes it.
 */

const acct = (accountId: string, label = accountId): ConnectorAccount => ({
	accountId,
	label,
	connectedAt: "2026-08-01",
	grantedScopes: null,
});

const WORK = acct("serge.pro.job@gmail.com");
const HOME = acct("sivochkin@gmail.com");
const LEGACY = acct("", null as unknown as string);

describe("nothing connected", () => {
	it("says so, in the words every caller already expects", () => {
		const r = resolveConnectorAccount([], undefined, "Gmail");
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ reason: "not_connected", message: "Gmail is not connected." });
	});
});

describe("one account — the case nobody had to configure", () => {
	it("resolves to it with no choice recorded", () => {
		expect(resolveConnectorAccount([HOME], undefined, "Gmail")).toEqual({ ok: true, account: HOME });
	});

	it("resolves the legacy unnamed row the same way", () => {
		// Every connection made before the multi-account vault sits at account_id ''. Nobody
		// should have to go and pick it.
		expect(resolveConnectorAccount([LEGACY], undefined, "Gmail")).toEqual({ ok: true, account: LEGACY });
	});

	it("treats an empty-string pin as no pin, not as a pin on the legacy row", () => {
		expect(resolveConnectorAccount([HOME], "", "Gmail")).toEqual({ ok: true, account: HOME });
	});
});

describe("two accounts and no choice — REFUSES rather than picking", () => {
	const two = [WORK, HOME];

	it("refuses", () => {
		const r = resolveConnectorAccount(two, undefined, "Gmail");
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ reason: "ambiguous" });
	});

	it("never silently resolves to the first, the newest, or any of them", () => {
		const r = resolveConnectorAccount(two, undefined, "Gmail");
		// The property that matters: NO account comes back. Order must not become a convention.
		expect("account" in r).toBe(false);
	});

	it("names both accounts and where to choose, so the refusal is actionable", () => {
		const r = resolveConnectorAccount(two, undefined, "Gmail");
		if (r.ok) throw new Error("expected a refusal");
		expect(r.message).toContain("serge.pro.job@gmail.com");
		expect(r.message).toContain("sivochkin@gmail.com");
		expect(r.message).toContain("Settings");
		// It must also say nothing happened — a model relaying this should not imply a half-send.
		expect(r.message).toMatch(/nothing is sent or read until you do/i);
	});

	it("resolves once a choice is recorded", () => {
		expect(resolveConnectorAccount(two, "sivochkin@gmail.com", "Gmail")).toEqual({ ok: true, account: HOME });
		expect(resolveConnectorAccount(two, "serge.pro.job@gmail.com", "Gmail")).toEqual({ ok: true, account: WORK });
	});
});

describe("a pin that has gone stale", () => {
	it("refuses instead of falling back to another account", () => {
		// The dangerous case: an agent pinned to a mailbox the owner disconnected. Falling back
		// is the wrong-identity bug arriving on a schedule, weeks later, with nobody watching.
		const r = resolveConnectorAccount([WORK], "sivochkin@gmail.com", "Gmail");
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ reason: "pinned_account_gone" });
		expect("account" in r).toBe(false);
	});

	it("refuses even when only ONE account remains — a lone survivor is not a default", () => {
		const r = resolveConnectorAccount([WORK], "gone@example.test", "Gmail");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.message).toContain("gone@example.test");
		expect(r.message).toContain("serge.pro.job@gmail.com");
	});
});

describe("how an account reads in a refusal", () => {
	it("prefers the address, falls back to the id, then to a plain phrase", () => {
		const noLabel: ConnectorAccount = { accountId: "abc123", label: null, connectedAt: null, grantedScopes: null };
		const nothing: ConnectorAccount = { accountId: "", label: "   ", connectedAt: null, grantedScopes: null };
		const r = resolveConnectorAccount([noLabel, nothing], undefined, "Gmail");
		if (r.ok) throw new Error("expected a refusal");
		expect(r.message).toContain("abc123");
		expect(r.message).toContain("an unnamed connection");
	});
});

describe("pinnedAccountsFrom", () => {
	it("reads the per-provider choices off an instance config", () => {
		expect(pinnedAccountsFrom({ connectorAccounts: { gmail: "me@example.test", google_drive: "work@example.test" } })).toEqual({
			gmail: "me@example.test",
			google_drive: "work@example.test",
		});
	});

	it("ignores anything that is not a non-empty string", () => {
		expect(pinnedAccountsFrom({ connectorAccounts: { a: "", b: "   ", c: 42, d: null, e: ["x"] } })).toEqual({});
	});

	it("trims, so a pasted address with a stray space still matches its row", () => {
		expect(pinnedAccountsFrom({ connectorAccounts: { gmail: "  me@example.test " } })).toEqual({ gmail: "me@example.test" });
	});

	it("survives every shape a config can actually be", () => {
		for (const config of [null, undefined, 42, "str", [], {}, { connectorAccounts: null }, { connectorAccounts: [] }, { connectorAccounts: "x" }]) {
			expect(pinnedAccountsFrom(config)).toEqual({});
		}
	});
});
