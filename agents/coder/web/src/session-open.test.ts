import { describe, expect, it } from "vitest";
import { activeSessionFor, pickAutoOpenSession, repoForSession } from "./session-open";
import type { CodingRepo, CodingSession } from "./types";

const s = (id: string, repoId: string, status: CodingSession["status"]): CodingSession => ({ id, repoId, status });

const SESSIONS = [
	s("ended-a", "repo-a", "ended"),
	s("live-a", "repo-a", "active"),
	s("live-b", "repo-b", "active"),
	s("suspended-c", "repo-c", "suspended"),
];

describe("nothing to open", () => {
	it("opens nothing when there are no sessions at all", () => {
		expect(pickAutoOpenSession({ sessions: [], initialSessionId: "live-a", singleRepo: true, lastRepoId: "repo-a" })).toBeNull();
	});

	it("opens nothing for a multi-repo agent with no deep link and no remembered repo", () => {
		// This is the default landing, and it is the point: the tab used to attach to whichever
		// active session came first, which yanked people into a terminal they did not ask for.
		expect(pickAutoOpenSession({ sessions: SESSIONS })).toBeNull();
	});

	it("opens nothing when the remembered repo's session has since ended", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, lastRepoId: "repo-c" })).toBeNull();
		expect(pickAutoOpenSession({ sessions: SESSIONS, lastRepoId: "repo-gone" })).toBeNull();
	});
});

describe("a deep link wins outright", () => {
	it("opens the named session even for a single-repo agent with a different live one", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, initialSessionId: "live-b", singleRepo: true })?.id).toBe("live-b");
	});

	it("opens an ENDED session — the URL names it, and #257 means it still has a transcript", () => {
		// The other two branches want a session you can type into; this one wants the one the
		// link points at. Filtering it by status would send a shared link to an empty repo list.
		expect(pickAutoOpenSession({ sessions: SESSIONS, initialSessionId: "ended-a" })?.id).toBe("ended-a");
	});

	it("opens nothing — never a fallback — when the linked session is gone", () => {
		// Falling through to "the last repo" would silently open something the link did not name.
		expect(pickAutoOpenSession({ sessions: SESSIONS, initialSessionId: "deleted", lastRepoId: "repo-a" })).toBeNull();
		expect(pickAutoOpenSession({ sessions: SESSIONS, initialSessionId: "deleted", singleRepo: true })).toBeNull();
	});
});

describe("a single-repo agent attaches to its live session", () => {
	it("takes the active one", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, singleRepo: true })?.id).toBe("live-a");
	});

	it("ignores the remembered repo — there is nothing to disambiguate", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, singleRepo: true, lastRepoId: "repo-b" })?.id).toBe("live-a");
	});

	it("takes only an ACTIVE one, so it never lands on a dead terminal", () => {
		expect(pickAutoOpenSession({ sessions: [s("x", "repo-a", "ended")], singleRepo: true })).toBeNull();
		expect(pickAutoOpenSession({ sessions: [s("x", "repo-a", "suspended")], singleRepo: true })).toBeNull();
	});
});

describe("a multi-repo agent restores the repo it was last in", () => {
	it("opens that repo's live session", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, lastRepoId: "repo-b" })?.id).toBe("live-b");
	});

	it("matches on the REPO, not the session — a session id does not survive a restart", () => {
		// localStorage holds a repo id for exactly this reason: the Pilot ends a session on every
		// finished run, so a remembered session id would be stale by the next visit.
		expect(pickAutoOpenSession({ sessions: SESSIONS, lastRepoId: "live-b" })).toBeNull();
	});

	it("skips the repo's ended session and takes its live one", () => {
		expect(pickAutoOpenSession({ sessions: SESSIONS, lastRepoId: "repo-a" })?.id).toBe("live-a");
	});
});

describe("the one session you can type into", () => {
	it("finds the active session for a repo", () => {
		expect(activeSessionFor(SESSIONS, "repo-a")?.id).toBe("live-a");
	});

	it("passes over an ended one that comes FIRST in the list", () => {
		// `repo-a` has both, ended first — an order-blind `find` on repoId alone returns the dead
		// one, and every caller then drives a session that no longer exists.
		expect(SESSIONS[0].repoId).toBe("repo-a");
		expect(activeSessionFor(SESSIONS, "repo-a")?.status).toBe("active");
	});

	it("does not count a SUSPENDED session as one you can drive", () => {
		// `pags up --force` on another machine suspends sessions rather than ending them: the
		// history is preserved, but this node cannot type into it.
		expect(activeSessionFor(SESSIONS, "repo-c")).toBeUndefined();
	});

	it("answers undefined for a repo with nothing running", () => {
		expect(activeSessionFor(SESSIONS, "repo-none")).toBeUndefined();
	});
});

describe("which repo an open session belongs to", () => {
	const repos: CodingRepo[] = [
		{ id: "repo-a", name: "platform" },
		{ id: "repo-b", name: "site" },
	];

	it("answers from the session's own repoId", () => {
		expect(repoForSession(repos, SESSIONS[1])?.name).toBe("platform");
	});

	it("answers for an ENDED session too — the header prints a name either way", () => {
		// The long way round ("which repo has this as its ACTIVE session") returned nothing here,
		// and the header fell back to rendering the raw repo UUID where the name goes. Reachable
		// by any deep link, and the platform ends sessions by itself constantly.
		const ended = SESSIONS[0];
		expect(ended.status).toBe("ended");
		expect(repoForSession(repos, ended)?.name).toBe("platform");
	});

	it("answers null with no session, and for a repo that has been deleted", () => {
		expect(repoForSession(repos, null)).toBeNull();
		expect(repoForSession(repos, s("x", "repo-gone", "active"))).toBeNull();
	});
});
