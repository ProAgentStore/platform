import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GRANTABLE_ROLES,
	deleteAgentRequest,
	revokeKeyRequest,
	roleCheckboxLocked,
	rolesChanged,
	rolesPayload,
	suspendGuard,
} from "./moderation-policy";

describe("self-targeting is refused, with a reason", () => {
	it("disables self-suspension rather than offering a button that only ever errors", () => {
		// The failure this prevents: the operator suspends their own account and is then
		// locked out of the portal they would need in order to undo it.
		const g = suspendGuard("user-1", "user-1");
		expect(g.disabled).toBe(true);
		expect(g.reason).toBeTruthy();
		expect(g.reason).toMatch(/your own/i);
	});

	it("leaves other accounts alone", () => {
		expect(suspendGuard("user-2", "user-1").disabled).toBe(false);
	});

	it("does not guess when the operator's own id is unknown", () => {
		// `useSelfId` resolves asynchronously and returns null on failure. Guessing "this
		// might be me" would disable moderation of a real account; guessing the other way
		// only means the API's own refusal is the backstop, which it always is.
		expect(suspendGuard("user-1", null).disabled).toBe(false);
	});

	it("locks removing your OWN admin role — the same lockout by a quieter route", () => {
		expect(roleCheckboxLocked("admin", true, ["user", "admin"])).toBe(true);
	});

	it("still lets you grant yourself a role you do not have", () => {
		// Only the role that got you here is protected. Self-granting `creator` locks
		// nobody out of anything.
		expect(roleCheckboxLocked("creator", true, ["user", "admin"])).toBe(false);
		expect(roleCheckboxLocked("admin", true, ["user"])).toBe(false);
	});

	it("never locks a checkbox on someone else's account", () => {
		expect(roleCheckboxLocked("admin", false, ["user", "admin"])).toBe(false);
	});
});

describe("rolesPayload — the PUT is a set, not a patch", () => {
	it("always includes `user`", () => {
		// The API implies it and it is never removable; omitting it from a set-semantics
		// PUT would ask the server to strip the base role from the account.
		expect(rolesPayload([])).toEqual(["user"]);
		expect(rolesPayload(["admin"])).toEqual(["user", "admin"]);
		expect(rolesPayload(["user", "admin"])).toEqual(["user", "admin"]);
	});

	it("deduplicates", () => {
		expect(rolesPayload(["admin", "admin", "creator"])).toEqual(["user", "admin", "creator"]);
	});

	it("PRESERVES a role the UI has no checkbox for", () => {
		// The failure this prevents: a role added server-side but not yet added to
		// GRANTABLE_ROLES gets silently stripped by an operator who opened the form to
		// change something else entirely — a privilege change nobody asked for, arriving
		// through a control that never displayed it.
		expect(rolesPayload(["admin", "auditor"])).toContain("auditor");
	});

	it("changed-detection ignores order", () => {
		// Otherwise every save looks like a change and the button never disables.
		expect(rolesChanged(["user", "admin"], ["admin", "user"])).toBe(false);
		expect(rolesChanged(["user", "admin"], ["user"])).toBe(true);
		expect(rolesChanged(["user"], ["user", "admin"])).toBe(true);
	});

	it("keeps `user` out of the grantable set", () => {
		expect(GRANTABLE_ROLES).not.toContain("user");
	});
});

describe("key revoke is per-provider and can never widen", () => {
	it("names the provider explicitly", () => {
		expect(revokeKeyRequest("anthropic")).toEqual({ provider: "anthropic" });
	});

	it("refuses a blank provider instead of sending the field absent", () => {
		// The failure this prevents: an omitted provider reaching a server that reads the
		// absence as "all of them", wiping every stored key the account has.
		expect(() => revokeKeyRequest("")).toThrow(/per-provider/i);
		expect(() => revokeKeyRequest("   ")).toThrow(/per-provider/i);
	});
});

describe("deleteAgentRequest — the echo the SERVER checks is the one the operator typed", () => {
	it("sends the typed value, not the slug read back from props", () => {
		// The failure this prevents is total: if the body carries the correct slug taken
		// from the loaded agent, then a regressed UI gate still produces a perfectly valid
		// delete, and the server's own echo check — the backstop — can never fire.
		expect(deleteAgentRequest("my-agent", "my-agent", undefined)).toEqual({ confirm: "my-agent", force: false });
	});

	it("refuses to build a request at all when the echo does not match", () => {
		expect(() => deleteAgentRequest("my-agent", "wrong", undefined)).toThrow(/type my-agent/i);
		expect(() => deleteAgentRequest("my-agent", "", undefined)).toThrow();
		expect(() => deleteAgentRequest("my-agent", undefined, undefined)).toThrow();
		expect(() => deleteAgentRequest("my-agent", "my-agent ", undefined)).toThrow();
	});

	it("refuses when there is no slug to confirm against", () => {
		// An agent with no slug has no phrase, so the echo box would accept anything —
		// including the empty string it starts with, i.e. one click.
		expect(() => deleteAgentRequest("", "", undefined)).toThrow(/no slug/i);
	});

	it("passes force through only as an explicit true", () => {
		expect(deleteAgentRequest("my-agent", "my-agent", true).force).toBe(true);
		expect(deleteAgentRequest("my-agent", "my-agent", false).force).toBe(false);
		expect(deleteAgentRequest("my-agent", "my-agent", undefined).force).toBe(false);
	});
});

/** Strip comments before matching — see store/console/src/lib/surfaces.test.ts. */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("the pages consume these guards rather than restating them", () => {
	it("UserDetail asks the policy about self-targeting, roles and revoke", () => {
		const src = codeOf("../pages/UserDetail.tsx");
		expect(src).toContain("suspendGuard");
		expect(src).toContain("rolesPayload");
		expect(src).toContain("roleCheckboxLocked");
		expect(src).toContain("revokeKeyRequest");
	});

	it("AgentDetail builds its delete body here, so the typed echo is what ships", () => {
		const src = codeOf("../pages/AgentDetail.tsx");
		expect(src).toContain("deleteAgentRequest");
		// The old shape substituted the known-good slug into the body regardless of input.
		expect(src).not.toMatch(/confirm:\s*a\.slug/);
	});
});
