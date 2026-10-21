import { describe, expect, it } from "vitest";
import { addressesIn, gmailIdentityFromConfig, recipientInScope, replyRecipient, resolveSender, scopedQuery, textWindow, validPageToken } from "./gmail-identity.js";

describe("addressesIn", () => {
	it("reads mailboxes, not display names or comments", () => {
		expect(addressesIn('"admin@a.test" <real@b.test>, Bob (bob@c.test) <bob@d.test>, plain@e.test')).toEqual(["real@b.test", "bob@d.test", "plain@e.test"]);
	});
	it("ignores what is not an address", () => {
		expect(addressesIn("undisclosed-recipients:;")).toEqual([]);
		expect(addressesIn("")).toEqual([]);
	});
});

describe("recipientInScope", () => {
	const h = (o: Partial<Record<"to" | "cc" | "deliveredTo" | "xOriginalTo", string>>) => ({ to: "", cc: "", deliveredTo: "", xOriginalTo: "", ...o });
	it("is open with an empty scope and closed to mail that never names the address", () => {
		expect(recipientInScope([], h({ to: "x@y.test" }))).toBe(true);
		expect(recipientInScope(["a@s.test"], h({ to: "x@y.test" }))).toBe(false);
	});
	it("matches To, Cc, X-Original-To and the receiving Delivered-To", () => {
		for (const k of ["to", "cc", "deliveredTo", "xOriginalTo"] as const) expect(recipientInScope(["a@s.test"], h({ [k]: "Name <A@S.test>" })), k).toBe(true);
	});
});

describe("gmailIdentityFromConfig", () => {
	it("is none when absent, invalid (never none) when present but wrong", () => {
		expect(gmailIdentityFromConfig(null).state).toBe("none");
		expect(gmailIdentityFromConfig("{}").state).toBe("none");
		expect(gmailIdentityFromConfig('{"gmailIdentity":null}').state).toBe("none");
		for (const bad of ['{"gmailIdentity":"x"}', '{"gmailIdentity":{"sendAs":"nope"}}', '{"gmailIdentity":{"inboundScope":["a@b.test","x"]}}', '{"gmailIdentity":{"previewChars":5}}', "{bad"]) {
			expect(gmailIdentityFromConfig(bad).state, bad).toBe("invalid");
		}
	});
	it("normalises and dedupes", () => {
		const r = gmailIdentityFromConfig('{"gmailIdentity":{"sendAs":"A@B.test","inboundScope":["C@D.test","c@d.test"]}}');
		expect(r).toEqual({ state: "configured", pin: { sendAs: "a@b.test", inboundScope: ["c@d.test"], previewChars: 8000 } });
	});
});

describe("misc", () => {
	it("scopes a query", () => {
		expect(scopedQuery(["a@b.test"], "")).toBe("(to:a@b.test OR cc:a@b.test OR deliveredto:a@b.test)");
	});
	it("resolves only verified senders", () => {
		const a = (email: string, verified: boolean) => ({ email, displayName: "", replyToAddress: "", isPrimary: false, isDefault: false, verificationStatus: "", verified });
		expect(resolveSender([a("a@b.test", true)], "a@b.test").ok).toBe(true);
		expect(resolveSender([a("a@b.test", false)], "a@b.test")).toMatchObject({ ok: false, code: "alias_unverified" });
		expect(resolveSender([], "a@b.test")).toMatchObject({ ok: false, code: "alias_missing" });
		expect(resolveSender([], null)).toMatchObject({ ok: false, code: "no_sender_pinned" });
	});
	it("reply recipient prefers one foreign Reply-To", () => {
		expect(replyRecipient({ from: "F <f@x.test>", replyTo: "r@x.test" }, ["me@x.test"])).toEqual({ to: "r@x.test", viaReplyTo: true });
		expect(replyRecipient({ from: "F <f@x.test>", replyTo: "me@x.test" }, ["me@x.test"]).viaReplyTo).toBe(false);
	});
	it("never splits a surrogate pair at a window edge", () => {
		const s = "ab😀cd";
		const w = textWindow(s, 0, 3);
		expect(w.text).toBe("ab");
		expect(w.nextOffset).toBe(2);
		expect(textWindow(s, 2, 10).text).toBe("😀cd");
	});
	it("accepts only url-safe page tokens", () => {
		expect(validPageToken("123-abc_")).toBe("123-abc_");
		expect(validPageToken("a&b")).toBeNull();
		expect(validPageToken(5)).toBeNull();
	});
});
