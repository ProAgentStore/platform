import { describe, expect, it } from "vitest";
import { type ConnectorEntry, connectionFingerprint, signInCompleted } from "./accountConnections";

const grants = (held: string[]) => ["send", "archive"].map((id) => ({ id, label: id, held: held.includes(id) }));
const gmail = (held: string[], connectedAt = "2026-07-01T00:00:00Z"): ConnectorEntry => ({
	id: "gmail", label: "Gmail", auth: "oauth", grantModel: "user", configured: true, connected: true, account: "a@x.com", connectedAt, reach: null, flow: null,
	accounts: [{ accountId: "a1", label: "a@x.com", connectedAt, missingScopes: [], optionalGrants: grants(held) }],
});

describe("the sign-in instruction's lifecycle (#1281)", () => {
	it("is still waiting while the connection reads the same", () => {
		const before = connectionFingerprint(gmail([]));
		expect(signInCompleted(before, [gmail([])], "gmail")).toBe(false);
	});
	it("is complete once a grant is allowed, an account is refreshed or added, or the connector appears", () => {
		const before = connectionFingerprint(gmail([]));
		expect(signInCompleted(before, [gmail(["send"])], "gmail")).toBe(true);
		expect(signInCompleted(before, [gmail([], "2026-10-22T00:00:00Z")], "gmail")).toBe(true);
		expect(signInCompleted(before, [{ ...gmail([]), accounts: [...(gmail([]).accounts ?? []), { accountId: "a2", label: "b@x.com", connectedAt: null }] }], "gmail")).toBe(true);
		expect(signInCompleted(connectionFingerprint(undefined), [gmail([])], "gmail")).toBe(true);
	});
	it("only looks at the connector that was being signed in to", () => {
		const before = connectionFingerprint(gmail([]));
		expect(signInCompleted(before, [gmail([]), { ...gmail(["send"]), id: "drive" }], "gmail")).toBe(false);
	});
});
