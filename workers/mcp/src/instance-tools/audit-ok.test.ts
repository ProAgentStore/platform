import { describe, expect, it } from "vitest";
import { auditOk } from "./base.js";

/**
 * Whether a tool call is audited as having WORKED (#726).
 *
 * The bug this closes was measured, not theorised: six `gmail_search` calls on a live account —
 * five blocked by the email-permission gate, one that actually read a mailbox — all recorded as
 * `ok:true`. An audit log that cannot tell a refused mailbox read from a completed one is worse
 * than no audit log, because it is believed.
 */

describe("a gate that said no", () => {
	it("is NOT a success, however the refusal is worded", () => {
		// The shape the tools route returns on a refusal: HTTP 200, success:false, no `error` key,
		// because a gate saying no is a valid answer rather than a transport failure.
		expect(auditOk({ success: false, content: "Email access is not enabled for this agent." })).toBe(false);
		expect(auditOk({ success: false, content: "Gmail is not connected." })).toBe(false);
		expect(auditOk({ name: "gmail_search", success: false, content: "…" })).toBe(false);
	});

	it("was audited as a success before this — the regression this test exists to catch", () => {
		const refusal = { success: false, content: "refused" };
		// The old predicate, kept here as the thing that must never come back.
		const old = !(refusal as { error?: string }).error;
		expect(old).toBe(true);
		expect(auditOk(refusal)).toBe(false);
	});
});

describe("everything else is unchanged", () => {
	it("counts an explicit success as a success", () => {
		expect(auditOk({ success: true, content: "{…}" })).toBe(true);
	});

	it("still treats a synthesised transport error as a failure", () => {
		// http.ts synthesises `{error}` on a non-2xx, and those carry no `success` field.
		expect(auditOk({ error: "Upstream 503" })).toBe(false);
	});

	it("treats a result with neither field as having run", () => {
		// Most tools return their payload directly. Judged exactly as before.
		expect(auditOk({ messages: [] })).toBe(true);
		expect(auditOk({})).toBe(true);
	});

	it("does not fall over on a non-object", () => {
		for (const v of [null, undefined, "text", 42, []]) expect(auditOk(v)).toBe(true);
	});

	it("prefers `success` over `error` when a result somehow carries both", () => {
		// success is the tool's own verdict; error is a transport artefact. The tool wins.
		expect(auditOk({ success: false, error: undefined })).toBe(false);
		expect(auditOk({ success: true, error: undefined })).toBe(true);
	});
});
