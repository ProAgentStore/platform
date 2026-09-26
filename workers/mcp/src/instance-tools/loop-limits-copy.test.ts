/**
 * The objective cap is copied into this worker (#854) — it cannot import the API worker — so the
 * copies are held to the source they copy, or a changed limit would publish a schema `.max()` and
 * tool descriptions that disagree with what the route enforces.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_OBJECTIVE_CHARS, MAX_CONFIGURABLE_ITERATIONS, MAX_CONFIGURABLE_OBJECTIVE_CHARS, MIN_CONFIGURABLE_OBJECTIVE_CHARS } from "./composition.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("the loop-limit copies match workers/api/src/lib/loop-limits.ts", () => {
	it("holds every copied number to its source", () => {
		const src = readFileSync(resolve(HERE, "../../../api/src/lib/loop-limits.ts"), "utf8");
		const read = (name: string) => {
			const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(src);
			expect(m, `could not find ${name} in lib/loop-limits.ts — this guard is measuring nothing`).not.toBeNull();
			return Number(m?.[1].replaceAll("_", ""));
		};
		expect({ DEFAULT_MAX_OBJECTIVE_CHARS, MIN_CONFIGURABLE_OBJECTIVE_CHARS, MAX_CONFIGURABLE_OBJECTIVE_CHARS, MAX_CONFIGURABLE_ITERATIONS }).toEqual({
			DEFAULT_MAX_OBJECTIVE_CHARS: read("DEFAULT_MAX_OBJECTIVE_CHARS"),
			MIN_CONFIGURABLE_OBJECTIVE_CHARS: read("MIN_CONFIGURABLE_OBJECTIVE_CHARS"),
			MAX_CONFIGURABLE_OBJECTIVE_CHARS: read("MAX_CONFIGURABLE_OBJECTIVE_CHARS"),
			MAX_CONFIGURABLE_ITERATIONS: read("MAX_CONFIGURABLE_ITERATIONS"),
		});
	});
});
