/**
 * #1158: `pags login` on Windows opened an empty console window instead of the browser — `exec('start "<url>"')`,
 * and cmd's `start` takes its first quoted argument as the window title. The browser is now opened by a program and
 * its arguments, with no shell anywhere, so nothing in the URL is parsed on the way.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserCommand } from "./login.js";

// The real shape: an OAuth start URL carrying an encoded callback, plus a second parameter.
const url = "https://api.proagentstore.online/v1/auth/google/start?return_to=http%3A%2F%2F127.0.0.1%3A53123%2Fcallback&prompt=select_account";

describe("opening the sign-in page in a browser (#1158)", () => {
	it("Windows: asks the URL handler directly — no cmd, so no `start` title argument and no `&` to escape", () => {
		expect(browserCommand(url, "win32")).toEqual({ file: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
		const { file, args } = browserCommand(url, "win32");
		expect([file, ...args.slice(0, -1)].join(" ")).not.toMatch(/\bstart\b|cmd/i); // the launcher, not the URL
		expect(args.at(-1)).toBe(url); // the query string arrives whole: `&prompt=…` and every `%2F` intact
	});

	it("macOS and Linux: `open` / `xdg-open` with the URL as one argument, not a shell line", () => {
		expect(browserCommand(url, "darwin")).toEqual({ file: "open", args: [url] });
		expect(browserCommand(url, "linux")).toEqual({ file: "xdg-open", args: [url] });
	});

	it("launches with spawn (no shell), and prints the URL on every OS whatever the browser does", () => {
		const src = readFileSync(new URL("./login.ts", import.meta.url), "utf-8");
		// No `exec` from child_process (a shell line) — static or dynamic import.
		expect(src).not.toMatch(/import \{[^}]*\bexec\b[^}]*\} from "node:child_process"|child_process"\)\)\.exec\b/);
		expect(src).toMatch(/import \{ spawn \} from "node:child_process";/);
		expect(src).not.toMatch(/shell:\s*true/);
		expect(src).toMatch(/writeLine\(` {2}\$\{oauthUrl\}`\);\s*openBrowser\(oauthUrl\);/);
	});
});
