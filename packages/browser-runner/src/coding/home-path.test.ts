import { describe, expect, it } from "vitest";
import { homeRelative, resolveHomePath } from "./home-path.js";

const mac = { platform: "darwin" as const, home: "/Users/sergeivo", exists: () => false };
const linux = { platform: "linux" as const, home: "/home/dev", exists: () => false };
const win = { platform: "win32" as const, home: "C:\\Users\\Dell", exists: () => false };

describe("a stored folder is home-relative and each machine expands it against its own home (#1379)", () => {
	it("expands ~/ on macOS, Linux and Windows to that machine's home, on that machine's separators", () => {
		expect(resolveHomePath("~/dev/stores/pas/apps/hiring", mac)).toEqual({ requested: "~/dev/stores/pas/apps/hiring", path: "/Users/sergeivo/dev/stores/pas/apps/hiring", via: "tilde" });
		expect(resolveHomePath("~/dev/stores/pas/apps/hiring", linux).path).toBe("/home/dev/dev/stores/pas/apps/hiring");
		expect(resolveHomePath("~/dev/stores/pas/apps/hiring", win).path).toBe("C:\\Users\\Dell\\dev\\stores\\pas\\apps\\hiring");
	});

	it("reads a Windows-style ~\\ the same way, and a bare ~ as the home folder", () => {
		expect(resolveHomePath("~\\dev\\x", win).path).toBe("C:\\Users\\Dell\\dev\\x");
		expect(resolveHomePath("~\\dev\\x", mac).path).toBe("/Users/sergeivo/dev/x");
		expect(resolveHomePath("~", mac)).toMatchObject({ path: "/Users/sergeivo", via: "tilde" });
	});

	it("a relative path means 'from home', never 'from wherever the runner started'", () => {
		expect(resolveHomePath("dev/x", mac)).toMatchObject({ path: "/Users/sergeivo/dev/x", via: "relative" });
		expect(resolveHomePath(".\\dev\\x", win)).toMatchObject({ path: "C:\\Users\\Dell\\dev\\x", via: "relative" });
	});

	it("the failure in #1379: another account's absolute path is carried over to this home when that account does not exist here", () => {
		const r = resolveHomePath("/Users/serge/dev/stores/pas/apps/hiring", mac);
		expect(r).toEqual({ requested: "/Users/serge/dev/stores/pas/apps/hiring", path: "/Users/sergeivo/dev/stores/pas/apps/hiring", via: "foreign-home" });
		expect(resolveHomePath("/Users/serge/dev/x", linux)).toMatchObject({ path: "/home/dev/dev/x", via: "foreign-home" });
		expect(resolveHomePath("/home/serge/dev/x", win)).toMatchObject({ path: "C:\\Users\\Dell\\dev\\x", via: "foreign-home" }); // a POSIX home cannot exist on Windows
		expect(resolveHomePath("C:\\Users\\Tiny\\dev\\x", win)).toMatchObject({ path: "C:\\Users\\Dell\\dev\\x", via: "foreign-home" });
	});

	it("never rewrites a path that is this machine's own, or whose account folder really exists here", () => {
		expect(resolveHomePath("/Users/sergeivo/dev/x", mac)).toMatchObject({ path: "/Users/sergeivo/dev/x", via: "absolute" });
		expect(resolveHomePath("/Users/shared/dev/x", { ...mac, exists: (p) => p === "/Users/shared" })).toMatchObject({ path: "/Users/shared/dev/x", via: "absolute" });
	});

	it("leaves a non-home absolute path alone", () => {
		expect(resolveHomePath("/srv/repos/x", linux)).toMatchObject({ path: "/srv/repos/x", via: "absolute" });
		expect(resolveHomePath("D:\\work\\x", win)).toMatchObject({ path: "D:\\work\\x", via: "absolute" });
	});
});

describe("homeRelative: the spelling that holds on any machine", () => {
	it("turns an absolute path under home into ~/…, with forward slashes even on Windows", () => {
		expect(homeRelative("/Users/sergeivo/dev/x", mac)).toBe("~/dev/x");
		expect(homeRelative("C:\\Users\\Dell\\dev\\x", win)).toBe("~/dev/x");
		expect(homeRelative("/Users/sergeivo", mac)).toBe("~");
	});
	it("is null for a path outside the home folder", () => {
		expect(homeRelative("/srv/repos/x", mac)).toBeNull();
		expect(homeRelative("D:\\work\\x", win)).toBeNull();
	});
	it("round-trips: expanding the home-relative form on the same machine gives the same path", () => {
		for (const o of [mac, linux, win]) {
			const abs = resolveHomePath("~/dev/a b/c", o).path;
			expect(resolveHomePath(homeRelative(abs, o) as string, o).path).toBe(abs);
		}
	});
});
