import { describe, expect, it } from "vitest";
import { stableStringify } from "./stable-json.js";

describe("stableStringify", () => {
	// The defect it exists to prevent (#226): `write_memory` ran four times against one key in a
	// single turn because the cross-round dedup keyed on JSON.stringify, which is key-order
	// dependent — so the same call with its fields emitted in a different order looked new.
	it("is key-order independent, which plain JSON.stringify is not", () => {
		const a = { key: "preference:response_style", value: "concise" };
		const b = { value: "concise", key: "preference:response_style" };
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(b)); // the bug
		expect(stableStringify(a)).toBe(stableStringify(b)); // the fix
	});

	it("sorts at every level, not just the top", () => {
		expect(stableStringify({ o: { b: 1, a: 2 } })).toBe(stableStringify({ o: { a: 2, b: 1 } }));
	});

	// Arrays are ORDERED data, not a bag of keys — reordering them changes meaning.
	it("preserves array order", () => {
		expect(stableStringify({ xs: [1, 2] })).not.toBe(stableStringify({ xs: [2, 1] }));
	});

	it("treats an explicitly-undefined field as absent, matching JSON.stringify", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
	});

	it("still distinguishes genuinely different values", () => {
		expect(stableStringify({ key: "k", value: "a" })).not.toBe(stableStringify({ key: "k", value: "b" }));
	});

	it("handles primitives, null and nesting without throwing", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(5)).toBe("5");
		expect(stableStringify("s")).toBe('"s"');
		expect(stableStringify({ a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}]}');
	});
});
