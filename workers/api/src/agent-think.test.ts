import { describe, expect, it } from "vitest";
import { withPartialToolLog } from "./agent-think.js";

describe("withPartialToolLog (#24 — surface committed side effects on a late failure)", () => {
	it("attaches the completed tool log to an Error and returns the same error", () => {
		const err = new Error("provider exploded mid-turn");
		const out = withPartialToolLog(err, ["✅ **create_task** done"]);
		expect(out).toBe(err);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toEqual(["✅ **create_task** done"]);
	});

	it("no-ops when nothing succeeded (empty tool log)", () => {
		const err = new Error("failed on round 0");
		withPartialToolLog(err, []);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toBeUndefined();
	});

	it("preserves the error's own type/status (creds/provider errors still propagate)", () => {
		const err = Object.assign(new Error("bad creds"), { status: 401 });
		const out = withPartialToolLog(err, ["✅ **insert_record** ok"]) as {
			status?: number;
			partialToolLog?: string[];
		};
		expect(out.status).toBe(401);
		expect(out.partialToolLog).toEqual(["✅ **insert_record** ok"]);
	});

	it("tolerates a non-object error without throwing", () => {
		expect(() => withPartialToolLog("string error", ["✅ x"])).not.toThrow();
		expect(withPartialToolLog("string error", ["✅ x"])).toBe("string error");
	});
});
