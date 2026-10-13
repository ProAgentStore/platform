import { describe, expect, it } from "vitest";
import { permissionCardActions, permissionCardExpiry, permissionCardInstanceLabel } from "./permissionCard";

describe("the permission card names its instance (#1009)", () => {
	it("by name, with the id that disambiguates two instances of one agent", () => {
		expect(permissionCardInstanceLabel("PAS Tradies App Coder", "b853fc25")).toBe("PAS Tradies App Coder (b853fc25)");
	});
	it("by id when the name is not known yet — never just 'this instance'", () => {
		expect(permissionCardInstanceLabel(undefined, "i1")).toBe("i1");
		expect(permissionCardInstanceLabel("   ", "i1")).toBe("i1");
	});
});

describe("the permission card says when the request expires (#1058)", () => {
	// Request 462b42ce: created 2:00:29 PM, expired 2:30:29 PM Melbourne time (03:30:29 UTC, AEDT).
	const expiresAt = "2026-10-13T03:30:29.000Z";
	const fmt = { locale: "en-US", timeZone: "Australia/Melbourne" };
	const at = (iso: string) => Date.parse(iso);

	it("pending: the expiry in the viewer's local time, with the time remaining", () => {
		expect(permissionCardExpiry({ status: "pending", expiresAt }, at("2026-10-13T03:00:29Z"), fmt)).toEqual({ expired: false, text: "Expires at 2:30:29 PM (30 min left)." });
		expect(permissionCardExpiry({ status: "pending", expiresAt }, at("2026-10-13T03:30:00Z"), fmt)).toEqual({ expired: false, text: "Expires at 2:30:29 PM (less than a minute left)." });
		expect(permissionCardExpiry({ status: "pending", expiresAt: "2026-10-13T05:00:29Z" }, at("2026-10-13T03:00:29Z"), fmt)?.text).toBe("Expires at 4:00:29 PM (2 h 0 min left).");
	});

	it("the same instant reads in each viewer's own zone", () => {
		expect(permissionCardExpiry({ status: "pending", expiresAt }, at("2026-10-13T03:00:29Z"), { locale: "en-US", timeZone: "UTC" })?.text).toBe("Expires at 3:30:29 AM (30 min left).");
	});

	it("expired: says it expired and when — whether marked expired or still pending past its deadline", () => {
		const expired = { expired: true, text: "Expired at 2:30:29 PM. It can no longer be approved; the agent must ask again." };
		expect(permissionCardExpiry({ status: "expired", expiresAt }, at("2026-10-13T03:31:00Z"), fmt)).toEqual(expired);
		expect(permissionCardExpiry({ status: "pending", expiresAt }, at("2026-10-13T03:30:29Z"), fmt)).toEqual(expired);
	});

	it("names the day when the deadline is not today", () => {
		expect(permissionCardExpiry({ status: "expired", expiresAt }, at("2026-10-15T00:00:00Z"), fmt)?.text).toMatch(/^Expired at Oct 13, 2:30:29 PM\./);
	});

	it("says nothing about expiry once the owner decided, or with no readable deadline", () => {
		for (const status of ["approved", "denied", "cancelled", "claimed"]) expect(permissionCardExpiry({ status, expiresAt }, at("2026-10-13T03:00:29Z"), fmt)).toBeNull();
		expect(permissionCardExpiry({ status: "pending", expiresAt: "" }, at("2026-10-13T03:00:29Z"), fmt)).toBeNull();
	});
});

describe("the permission card's decisions match the request kind (#1059)", () => {
	it("tool_enabled: names the tool and says approving switches it on for good, then runs the blocked call once", () => {
		const { actions, note, approved } = permissionCardActions({ control: "tool_enabled", operationKind: "gmail_search" });
		expect(actions).toEqual([{ label: "Switch on gmail_search", decision: "approve", primary: true }, { label: "Deny", decision: "deny" }]);
		expect(actions.map((a) => a.label).join(" ")).not.toMatch(/write|Ask each time/i);
		expect(actions.every((a) => a.mode === undefined)).toBe(true); // the server takes no mode for this kind
		expect(note).toBe("Approving switches gmail_search back on for this instance — it stays on until you switch it off under Tools — and runs the blocked call once.");
		expect(approved).toMatch(/^gmail_search is switched on/);
	});

	it("connector_consent: unchanged — write access always, ask each time, or deny", () => {
		const { actions, note, approved } = permissionCardActions({ control: "connector_consent", operationKind: "github_comment_issue" });
		expect(actions).toEqual([
			{ label: "Allow write access", decision: "approve", mode: "always", primary: true },
			{ label: "Ask each time", decision: "approve", mode: "ask" },
			{ label: "Deny", decision: "deny" },
		]);
		expect(note).toBeNull();
		expect(approved).toBe("Permission verified. The blocked operation may resume once through its verified continuation.");
	});
});
