import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessGateNotice } from "./api";

describe("accessGateNotice — an expired Access session is not a permission wall (#108 C5)", () => {
	it("rewrites both of the gate's 403s into what to do about them", () => {
		for (const error of ["Cloudflare Access required", "Invalid Cloudflare Access token"]) {
			const notice = accessGateNotice(403, error);
			expect(notice, error).toContain("Access session has expired");
			expect(notice, error).toContain("/admin/");
		}
	});

	it("leaves an ORDINARY 403 alone — 'Admin access required' is a real answer and must be shown", () => {
		// The failure this prevents: telling a non-admin to go and renew a session that is fine.
		expect(accessGateNotice(403, "Admin access required")).toBeNull();
		expect(accessGateNotice(403, undefined)).toBeNull();
	});

	it("matches on the status too, so the same words on another code are not rewritten", () => {
		expect(accessGateNotice(500, "Cloudflare Access required")).toBeNull();
	});

	it("does not tell a service-token caller to open a browser tab", () => {
		expect(accessGateNotice(403, "Cloudflare Access service tokens are not enabled for the admin API")).toBeNull();
	});

	// This app takes no dependency on the worker, so the strings are matched rather than imported.
	// Reading the source is what stops a reworded gate from silently turning this back into a raw
	// "Cloudflare Access required" — a drift nothing else would notice until an operator hit it.
	it("uses the gate's OWN words, read from the worker that says them", () => {
		const gate = readFileSync(join(__dirname, "../../../../workers/api/src/lib/cf-access.ts"), "utf-8");
		expect(gate).toContain('missing: "Cloudflare Access required"');
		expect(gate).toContain('invalid: "Invalid Cloudflare Access token"');
	});
});
