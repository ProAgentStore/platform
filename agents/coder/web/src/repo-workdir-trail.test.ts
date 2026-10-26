import { describe, expect, it } from "vitest";
import { workdirTrail } from "./repo-workdir-trail";

describe("the folder's translation trail (#1379)", () => {
	it("shows the stored home-relative folder, the path this machine made of it, and the rule", () => {
		expect(workdirTrail({ workdir: "~/dev/stores/pas/apps/hiring", workdirResolved: "/Users/sergeivo/dev/stores/pas/apps/hiring", workdirResolvedVia: "tilde" })).toBe(
			"~/dev/stores/pas/apps/hiring → /Users/sergeivo/dev/stores/pas/apps/hiring (~ expanded to that machine's home)",
		);
	});
	it("names the rescue of an old absolute path from another account", () => {
		expect(workdirTrail({ workdir: "/Users/serge/dev/x", workdirResolved: "/Users/sergeivo/dev/x", workdirResolvedVia: "foreign-home" })).toContain("another account's home path moved");
	});
	it("says nothing before a machine has resolved it, or when nothing was translated", () => {
		expect(workdirTrail({ workdir: "~/dev/x" })).toBeNull();
		expect(workdirTrail({ workdir: "/srv/x", workdirResolved: "/srv/x", workdirResolvedVia: "absolute" })).toBeNull();
		expect(workdirTrail({})).toBeNull();
	});
	it("tolerates a rule it does not know", () => {
		expect(workdirTrail({ workdir: "~/a", workdirResolved: "/h/a", workdirResolvedVia: "future" })).toBe("~/a → /h/a");
	});
});
