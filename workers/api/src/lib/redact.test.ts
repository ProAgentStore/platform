import { describe, expect, it } from "vitest";
import { redactJsonString, redactSecrets, redactText } from "./redact.js";

describe("redactText", () => {
	it("masks secret-shaped values", () => {
		expect(redactText("key is sk-abcdef1234567890xyz done")).toContain("[redacted]");
		expect(redactText("ghp_ABCDEFGHIJKLMNOPQRST1234")).toBe("[redacted]");
		expect(redactText("Authorization: Bearer abcdef123456ghijkl")).toContain("[redacted]");
		expect(redactText("nothing to see here")).toBe("nothing to see here");
	});
});

describe("redactSecrets", () => {
	it("redacts secret-named keys regardless of value", () => {
		const out = redactSecrets({ apiKey: "whatever", token: "x", nested: { password: "p", ok: "keep" } }) as Record<string, unknown>;
		expect(out.apiKey).toBe("[redacted]");
		expect(out.token).toBe("[redacted]");
		// Recursion into the nested object is the point of this case — a redactor that only walked
		// the top level would pass the two assertions above.
		const nested = out.nested as Record<string, unknown>;
		expect(nested.password).toBe("[redacted]");
		expect(nested.ok).toBe("keep");
	});
	it("masks secret-shaped values under innocent keys", () => {
		const out = redactSecrets({ note: "my key sk-abcdefghij1234567890" }) as Record<string, unknown>;
		expect(out.note).toContain("[redacted]");
	});
	it("handles arrays + primitives + null", () => {
		expect(redactSecrets(["a", { secret: "s" }, 5, null])).toEqual(["a", { secret: "[redacted]" }, 5, null]);
	});
});

describe("redactJsonString", () => {
	it("redacts a JSON string preserving shape", () => {
		const r = redactJsonString(JSON.stringify({ token: "abc", keep: 1 }));
		expect(JSON.parse(r!)).toEqual({ token: "[redacted]", keep: 1 });
	});
	it("falls back to text redaction for non-JSON", () => {
		expect(redactJsonString("raw ghp_ABCDEFGHIJKLMNOPQRST1234 text")).toContain("[redacted]");
	});
	it("passes through null/empty", () => {
		expect(redactJsonString(null)).toBeNull();
		expect(redactJsonString("")).toBeNull();
	});
});
