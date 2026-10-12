import { describe, expect, it } from "vitest";
import { type PoCounts, type PoIssue, classifyPoIssue, dependenciesOf, detailComment, digestLine, digestWorthSending, hasDetailComment, issueVersion, orderReady, poObjective } from "./po-triage.js";

/** A body that states the problem, acceptance criteria, scope and the area involved. */
const READY_BODY = [
	"The login page crashes when the email field is empty, which blocks new users from signing up at all.",
	"",
	"## Scope",
	"Only the login form; the signup flow is out of scope.",
	"",
	"## Area",
	"`src/login.ts`",
	"",
	"## Acceptance criteria",
	"- [ ] an empty email shows an inline error instead of crashing",
].join("\n");

const issue = (number: number, over: Partial<PoIssue> = {}): PoIssue => ({ number, title: `Issue ${number}`, body: READY_BODY, labels: [], ...over });
const ctx = (open: number[], complete = true) => ({ openIssues: new Set(open), openListComplete: complete });

describe("classifyPoIssue (#1027) — the four-issue fixture", () => {
	const fixture = [issue(1, { labels: ["needs-human"] }), issue(2, { body: `${READY_BODY}\n\nDepends on #1` }), issue(3, { body: "Make it better." }), issue(4)];
	const open = ctx(fixture.map((i) => i.number));

	it("waiting on a person, blocked, needs detail, ready — in that order of precedence", () => {
		expect(fixture.map((i) => classifyPoIssue(i, open).category)).toEqual(["waiting_on_human", "blocked", "needs_detail", "ready"]);
	});

	it("names what is missing, and why it is blocked, without quoting the issue", () => {
		expect(classifyPoIssue(fixture[1], open)).toMatchObject({ blockedBy: [1], reason: "Waits on #1, still open." });
		const vague = classifyPoIssue(fixture[2], open);
		expect(vague.missing).toHaveLength(4);
		expect(vague.reason).not.toContain("Make it better");
	});

	it("reuses the fleet's needs-human labels, including blocked-on-serge", () => {
		for (const label of ["needs-human", "needs human", "human-only", "blocked-on-serge", "blocked"]) expect(classifyPoIssue(issue(9, { labels: [label] }), open).category).toBe("waiting_on_human");
	});

	it("a dependency that has closed no longer blocks; one it could not see is treated as open", () => {
		const dependent = issue(2, { body: `${READY_BODY}\nBlocked by #77` });
		expect(classifyPoIssue(dependent, ctx([2])).category).toBe("ready");
		expect(classifyPoIssue(dependent, ctx([2], false)).category).toBe("blocked");
		expect(classifyPoIssue(issue(2, { body: `${READY_BODY}\nDepends on #2` }), ctx([2])).category).toBe("ready"); // itself
	});

	it("each detail check is independent", () => {
		const without = (re: RegExp) => classifyPoIssue(issue(5, { body: READY_BODY.replace(re, "") }), open);
		expect(without(/## Acceptance criteria\n- \[ \] .*/).missing).toEqual(["acceptance criteria (how we know it is done)"]);
		expect(without(/## Scope\n.*\n/).missing).toEqual(["the scope (what is in, and what is out)"]);
		expect(without(/`src\/login\.ts`/).missing).toEqual(["the files or area of the code involved"]);
	});
});

describe("orderReady (#1027)", () => {
	it("bugs first, then what others depend on, then epic children by epic, then oldest", () => {
		const all = [
			issue(10),
			issue(11, { body: `${READY_BODY}\nPart of #3` }),
			issue(12, { body: `${READY_BODY}\nPart of #2` }),
			issue(13),
			issue(14, { title: "Fix crash on save" }),
			issue(15, { labels: ["incident"] }),
			issue(20, { body: `${READY_BODY}\nDepends on #13` }),
		];
		const ready = all.filter((i) => i.number !== 20).map((i) => ({ issue: i }));
		expect(orderReady(ready, all).map((r) => r.issue.number)).toEqual([14, 15, 13, 12, 11, 10]);
	});
});

describe("the needs-detail comment (#1027)", () => {
	it("is posted once per version of the issue: the marker matches until the issue changes", () => {
		const v = issueVersion({ title: "T", body: "Make it better." });
		const comment = detailComment(["acceptance criteria"], v);
		expect(hasDetailComment([{ body: comment }], v)).toBe(true);
		expect(hasDetailComment([{ body: comment }], issueVersion({ title: "T", body: "Make it better, please." }))).toBe(false);
		expect(comment).toContain("- acceptance criteria");
	});

	it("puts the issue number first in the objective, which is what dedupe keys on", () => {
		expect(poObjective("acme/app", { number: 4, title: "Login crash" })).toMatch(/^Work issue #4 in acme\/app: Login crash\./);
		expect(dependenciesOf("depends on #3 and blocked by #4, depends on #3")).toEqual([3, 4]);
	});
});

describe("the digest (#1027)", () => {
	const counts = (over: Partial<PoCounts> = {}): PoCounts => ({ queued: 0, wouldQueue: 0, alreadyQueued: 0, ready: 0, waiting: 0, blocked: 0, needsDetail: 0, commented: 0, ...over });

	it("reads like the issue's example", () => {
		expect(digestLine("Tennis Clubs", counts({ queued: 2, waiting: 1, needsDetail: 1 }), false)).toBe("Tennis Clubs: queued 2, 1 waiting on you, 1 needs detail");
		expect(digestLine("Tennis Clubs", counts({ wouldQueue: 1, blocked: 2 }), true)).toBe("Tennis Clubs: would queue 1, 2 blocked (dry run)");
	});

	it("is sent when work was queued or commented on, or the picture moved — never for an unchanged wake", () => {
		const same = counts({ ready: 1, alreadyQueued: 1, waiting: 1 });
		expect(digestWorthSending(same, same)).toBe(false);
		expect(digestWorthSending(counts({ queued: 1 }), counts())).toBe(true);
		expect(digestWorthSending(counts({ commented: 1 }), counts())).toBe(true);
		expect(digestWorthSending(counts({ waiting: 2 }), counts({ waiting: 1 }))).toBe(true);
		expect(digestWorthSending(counts(), null)).toBe(false);
	});
});
