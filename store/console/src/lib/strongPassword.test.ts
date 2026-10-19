/** #1226 — the console's password generator for a login rotation. */
import { describe, expect, it } from "vitest";
import { strongPassword } from "./strongPassword";

describe("strongPassword (#1226)", () => {
	it("is 20 characters with a lower, an upper, a digit and a symbol, and no look-alikes", () => {
		for (let n = 0; n < 200; n++) {
			const p = strongPassword();
			expect(p).toHaveLength(20);
			expect(p).toMatch(/[a-z]/);
			expect(p).toMatch(/[A-Z]/);
			expect(p).toMatch(/[2-9]/);
			expect(p).toMatch(/[!@#$%^&*\-_=+?]/);
			expect(p).not.toMatch(/[01OlI]/);
		}
	});

	it("does not repeat, and does not always put the guaranteed classes first", () => {
		const seen = new Set(Array.from({ length: 500 }, () => strongPassword()));
		expect(seen.size).toBe(500);
		const firstFour = Array.from({ length: 300 }, () => strongPassword().slice(0, 4));
		expect(firstFour.some((s) => !/[a-z]/.test(s[0]) || !/[A-Z]/.test(s[1]))).toBe(true);
	});

	it("draws uniformly: a source that rejects out-of-range values is retried, never folded", () => {
		// The first draw is above the rejection limit for every alphabet here, so it must be discarded.
		const draws = [0xffff_ffff, 5, 6, 7, 8, ...Array.from({ length: 100 }, (_, i) => i)];
		let i = 0;
		const random = (out: Uint32Array) => {
			out[0] = draws[i++ % draws.length];
			return out;
		};
		expect(strongPassword(8, random)).toHaveLength(8);
	});
});
