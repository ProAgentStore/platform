import { describe, expect, it } from "vitest";
import { FALLBACK_TAB, parseInstanceSplat, resolveInstanceRoute } from "./instanceRoute";
import { checkConsoleLink, INSTANCE_TABS } from "./routes";

/** A coding agent: every built-in tab is reachable. */
const ALL_TABS = new Set<string>(INSTANCE_TABS);
/** A plain chat agent: nothing but the Assistant. */
const CHAT_ONLY = new Set<string>(["chat"]);

describe("parseInstanceSplat", () => {
	it("reads the tab from the first segment and the session id from the second", () => {
		expect(parseInstanceSplat("coding/csess_abc")).toEqual({ requestedTab: "coding", sessionId: "csess_abc", ignored: [] });
	});

	it("treats no splat, an empty splat and a bare slash as no tab at all", () => {
		for (const splat of [undefined, "", "/"]) {
			expect(parseInstanceSplat(splat)).toEqual({ requestedTab: "", sessionId: undefined, ignored: [] });
		}
	});

	it("is not shifted by a trailing or doubled slash", () => {
		expect(parseInstanceSplat("coding/").requestedTab).toBe("coding");
		expect(parseInstanceSplat("//coding").requestedTab).toBe("coding");
	});

	// #344, as data. The Worker's "Coder needs you" link carried four segments; the page read the
	// first two and the repo id + view silently became a session id it had never issued.
	it("reports the segments a too-deep link loses", () => {
		expect(parseInstanceSplat("coding/repos/repo_7/summary")).toEqual({
			requestedTab: "coding",
			sessionId: "repos",
			ignored: ["repo_7", "summary"],
		});
	});
});

describe("resolveInstanceRoute", () => {
	it("mounts the tab a link names when the instance exposes it", () => {
		expect(resolveInstanceRoute("knowledge", ALL_TABS)).toEqual({ tab: "knowledge", sessionId: undefined });
	});

	it("falls back to chat for a surface this agent does not have", () => {
		// A /coding deep link followed on a chat-only agent: the tab must not mount over data
		// that does not exist for it.
		expect(resolveInstanceRoute("coding/csess_abc", CHAT_ONLY).tab).toBe(FALLBACK_TAB);
	});

	it("falls back to chat for a tab that is not a tab at all", () => {
		expect(resolveInstanceRoute("repos", ALL_TABS).tab).toBe(FALLBACK_TAB);
		expect(resolveInstanceRoute(undefined, ALL_TABS).tab).toBe(FALLBACK_TAB);
	});

	it("keeps the session id through a fallback — one mistake should degrade one thing", () => {
		expect(resolveInstanceRoute("coding/csess_abc", CHAT_ONLY).sessionId).toBe("csess_abc");
	});

	it("accepts a custom (agent-published) surface id, which is not in the built-in table", () => {
		expect(resolveInstanceRoute("invoices", new Set(["chat", "invoices"])).tab).toBe("invoices");
	});
});

/**
 * The half that could not be written before (#344).
 *
 * `checkConsoleLink` rejects links on a claim about THIS parser, from a module the page did not
 * import. Nothing executed the parse it described, so the checker could have been wrong about
 * its own subject in either direction — rejecting good links, or passing links that silently
 * lose a segment — and no test could have told the difference. Now both run.
 */
describe("checkConsoleLink agrees with the parser it describes", () => {
	const link = (splat: string) => `/console/instances/inst_1/${splat}`;

	it("passes exactly the links whose every segment the page reads", () => {
		for (const splat of ["chat", "coding", "coding/csess_abc", "knowledge", "settings"]) {
			expect(checkConsoleLink(link(splat)).ok, splat).toBe(true);
			const { ignored } = parseInstanceSplat(splat);
			expect(ignored, `${splat} loses segments but was passed`).toEqual([]);
		}
	});

	it("rejects the #344 link, and the parser confirms it loses two segments", () => {
		const splat = "coding/repos/repo_7/summary";
		const verdict = checkConsoleLink(link(splat));
		expect(verdict.ok).toBe(false);
		expect(parseInstanceSplat(splat).ignored).toEqual(["repo_7", "summary"]);
	});

	it("rejects a tab this page would silently swap for chat", () => {
		const verdict = checkConsoleLink(link("repos"));
		expect(verdict.ok).toBe(false);
		expect(resolveInstanceRoute("repos", ALL_TABS).tab).toBe(FALLBACK_TAB);
	});

	// The registry and the checker's table are held equal in routes.test.ts; this holds the
	// checker's table against the thing that consumes it, so a tab added to one and not the
	// other cannot pass the link check and then land on the Assistant.
	it("every tab the checker allows is a tab this page will actually mount", () => {
		for (const tab of INSTANCE_TABS) {
			expect(checkConsoleLink(link(tab)).ok, tab).toBe(true);
			expect(resolveInstanceRoute(tab, ALL_TABS).tab, tab).toBe(tab);
		}
	});
});
