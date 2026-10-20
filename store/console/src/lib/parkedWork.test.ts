import { describe, expect, it } from "vitest";
import { parkedLine } from "./parkedWork";

describe("parkedLine (#1242)", () => {
	const base = { machineId: "m", node: "pink-laptop", workdir: "~/dev/x", snapshot: "7cf586197ba4f9be0ab07e3196cb4eae18687970", ref: "refs/pags/parked/r", pushedToOrigin: true };
	it("names the commit, the machine it is on, and whether origin has a copy", () => {
		expect(parkedLine(base)).toBe("Parked work 7cf5861 on pink-laptop · copy on origin");
		expect(parkedLine({ ...base, pushedToOrigin: false })).toBe("Parked work 7cf5861 on pink-laptop · no copy on origin — that machine holds the only one");
		expect(parkedLine({ ...base, pushedToOrigin: null })).toBe("Parked work 7cf5861 on pink-laptop");
	});
	it("a park with nothing set aside still names its machine; no park says nothing", () => {
		expect(parkedLine({ ...base, snapshot: null, ref: null, pushedToOrigin: null })).toBe("Parked on pink-laptop");
		expect(parkedLine(null)).toBe("");
	});
});
