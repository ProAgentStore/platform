/** #1078 — the "main moved" note the answer turn carries: what moved, every cut said out loud. */
import { describe, expect, it } from "vitest";
import { MOVED_FILES_SHOWN, movedNote, nameFiles } from "./coding-resume-sync.js";

describe("what the answer turn is told moved (#1078)", () => {
	it("names the files, and says how many more when it stops naming them", () => {
		expect(nameFiles(["a.ts"])).toBe("`a.ts`");
		const many = Array.from({ length: MOVED_FILES_SHOWN + 3 }, (_, i) => `f${i}.ts`);
		expect(nameFiles(many)).toMatch(/`f9\.ts` and 3 more$/);
		expect(nameFiles([])).toBe("no file list was available");
	});

	it("states the commits, the range and the instruction to re-read before acting on the answer", () => {
		const note = movedNote({ status: "healed", detail: "", branch: "main", from: "aaaaaaaa", to: "bbbbbbbb", commits: 1, sync: null }, ["src/x.ts"]);
		expect(note).toContain("`main` moved: 1 commit (aaaaaaaa → bbbbbbbb), touching `src/x.ts`");
		expect(note).toMatch(/Re-read any of those files you had touched before acting on the answer/);
	});
});
