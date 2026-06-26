import { describe, expect, it } from "vitest";
import { runApplyLoop, toolCallToDecision, type ApplyDeps, type ApplyDecision, type ApplyJob, type BrowserAction, type PageSnapshot } from "./apply-loop.js";

const JOB: ApplyJob = {
	url: "https://jobs.example.com/123",
	resumePath: "/tmp/resume.pdf",
	candidate: { fullName: "Sergey Ivochkin", email: "sergey@example.com" },
};

function scriptedDeps(snapshots: PageSnapshot[], decisions: ApplyDecision[]): { deps: ApplyDeps; acted: BrowserAction[] } {
	const acted: BrowserAction[] = [];
	let s = 0;
	let d = 0;
	const deps: ApplyDeps = {
		snapshot: async () => snapshots[Math.min(s++, snapshots.length - 1)],
		act: async (action) => {
			acted.push(action);
			return { url: "https://jobs.example.com/123", challenge: null };
		},
		decide: async () => decisions[Math.min(d++, decisions.length - 1)],
	};
	return { deps, acted };
}

const page = (snapshot: string, challenge: string | null = null): PageSnapshot => ({ url: "https://jobs.example.com/123", title: "Job", snapshot, challenge });

describe("runApplyLoop captcha suppression", () => {
	const pageAt = (url: string, challenge: string | null): PageSnapshot => ({ url, title: "x", snapshot: '- button "Create account"', challenge });

	it("suppresses a lingering captcha on the page just solved, but hands off on a NEW page", async () => {
		let s = 0;
		const snaps = [
			pageAt("https://ats.example.com/register", "captcha"), // SAME page a human solved → must be ignored
			pageAt("https://ats.example.com/verify", "captcha"), // a different page → fresh captcha → hand off
		];
		const deps: ApplyDeps = {
			snapshot: async () => snaps[Math.min(s++, snaps.length - 1)],
			act: async () => ({ url: "https://ats.example.com/verify", challenge: null }),
			decide: async () => ({ action: { action: "click", role: "button", name: "Create account" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 10, solvedChallengeUrl: "https://ats.example.com/register" });
		expect(result.outcome).toBe("captcha");
		expect(result.url).toBe("https://ats.example.com/verify"); // handed off on the new page, did NOT loop on the solved one
	});

	it("without a solved page, a captcha hands off immediately", async () => {
		const deps: ApplyDeps = {
			snapshot: async () => pageAt("https://ats.example.com/register", "captcha"),
			act: async () => ({ url: "x", challenge: null }),
			decide: async () => ({ action: { action: "click", role: "button", name: "x" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 10 });
		expect(result.outcome).toBe("captcha");
	});
});

describe("runApplyLoop", () => {
	it("drives type → upload → submit → finish(submitted)", async () => {
		const { deps, acted } = scriptedDeps(
			[page("- textbox \"Full name\""), page("- textbox \"Full name\": Sergey"), page("- button \"Submit\""), page("Application received")],
			[
				{ action: { action: "type", role: "textbox", name: "Full name", text: "Sergey Ivochkin" } },
				{ action: { action: "upload", name: "Resume", file: JOB.resumePath } },
				{ action: { action: "click", role: "button", name: "Submit" } },
				{ finish: { status: "submitted", detail: "Application received" } },
			],
		);
		const result = await runApplyLoop(deps, JOB, { maxSteps: 10 });
		expect(result.outcome).toBe("submitted");
		expect(result.detail).toBe("Application received");
		expect(acted.map((a) => a.action)).toEqual(["type", "upload", "click"]);
		expect(acted[1].file).toBe(JOB.resumePath);
	});

	it("short-circuits to captcha handoff the moment a challenge appears (no action taken)", async () => {
		const { deps, acted } = scriptedDeps(
			[page("- iframe", "recaptcha")],
			[{ action: { action: "click", name: "Submit" } }],
		);
		const result = await runApplyLoop(deps, JOB, { maxSteps: 10 });
		expect(result.outcome).toBe("captcha");
		expect(result.challenge).toBe("recaptcha");
		expect(acted).toHaveLength(0); // never acts past a captcha
	});

	it("stops at max_steps if the brain never finishes", async () => {
		const { deps } = scriptedDeps([page("- button \"Next\"")], [{ action: { action: "click", name: "Next" } }]);
		const result = await runApplyLoop(deps, JOB, { maxSteps: 3 });
		expect(result.outcome).toBe("max_steps");
		expect(result.steps).toBe(3);
	});

	it("does NOT flag stuck when the same-named button advances across DIFFERENT pages (Apply-now funnel)", async () => {
		// careers → job → login → apply → form → done: each "Apply now" click lands
		// on a NEW page. The page advances every time, so it's progress, not fixation.
		const urls = [
			"https://ats.example.com/careers",
			"https://ats.example.com/job/1",
			"https://ats.example.com/login",
			"https://ats.example.com/apply",
			"https://ats.example.com/form",
			"https://ats.example.com/done",
		];
		let s = 0;
		const deps: ApplyDeps = {
			snapshot: async () => ({ url: urls[Math.min(s, urls.length - 1)], title: "x", snapshot: `- button "Apply now" (p${s})`, challenge: null }),
			act: async () => { s++; return { url: urls[Math.min(s, urls.length - 1)], challenge: null }; },
			decide: async (p) => p.snapshot.url.endsWith("/done")
				? { finish: { status: "submitted", detail: "ok" } }
				: { action: { action: "click", role: "button", name: "Apply now" } },
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 20 });
		expect(result.outcome).toBe("submitted"); // progressed through the funnel, never falsely "stuck"
	});

	it("accumulates token usage into the shared opts.tokens object (so multi-round totals don't reset)", async () => {
		const tokens = { input: 5, output: 1 }; // pretend a prior round already spent some
		const deps: ApplyDeps = {
			snapshot: async () => page("- button \"Submit\""),
			act: async () => ({ url: "https://jobs.example.com/123", challenge: null }),
			decide: async () => ({ action: { action: "click", role: "button", name: "Submit" }, usage: { input: 100, output: 10 } }),
		};
		await runApplyLoop(deps, JOB, { maxSteps: 3, tokens });
		expect(tokens.input).toBe(305); // 5 carried in + 3 steps × 100
		expect(tokens.output).toBe(31);
	});

	it("injects a mid-flight pollHint message into the NEXT decision only (one-shot steering)", async () => {
		let polls = 0;
		const seen: Array<string | null> = [];
		const deps: ApplyDeps = {
			snapshot: async () => page('- button "Next"'),
			act: async () => ({ url: "https://jobs.example.com/123", challenge: null }),
			pollHint: async () => (polls++ === 1 ? "go to the next tab" : null), // your message arrives on step 2
			decide: async (p) => { seen.push(p.job.userHint ?? null); return { action: { action: "click", role: "button", name: "Next" } }; },
		};
		await runApplyLoop(deps, JOB, { maxSteps: 3 });
		expect(seen).toEqual([null, "go to the next tab", null]); // only the step after you sent it saw the message
	});

	it("STILL hands off stuck on a DYNAMIC page (content changes every poll) when fixating on one URL", async () => {
		// Same URL, but the snapshot grows each poll (a timer/carousel/ad). A content-
		// keyed guard would be defeated and thrash to max_steps; the URL-keyed guard
		// must still trip on the repeated dead click.
		let s = 0;
		const deps: ApplyDeps = {
			snapshot: async () => ({ url: "https://ats.example.com/job", title: "x", snapshot: `- button "Apply now"\n- text "${"·".repeat(s++)}"`, challenge: null }),
			act: async () => ({ url: "https://ats.example.com/job", challenge: null }),
			decide: async () => ({ action: { action: "click", role: "button", name: "Apply now" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 20 });
		expect(result.outcome).toBe("stuck");
	});

	it("breaks the loop after the same action fails 3× (no infinite retry)", async () => {
		const acted: BrowserAction[] = [];
		let decideCalls = 0;
		const deps: ApplyDeps = {
			snapshot: async () => page("- button \"Apply\""),
			act: async (a) => { acted.push(a); return { url: "x", challenge: null, error: "Timeout 10000ms exceeded" }; },
			decide: async () => { decideCalls++; return { action: { action: "click", role: "button", name: "Apply" } }; },
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 40 });
		expect(result.outcome).toBe("stuck"); // hands off to the human for this step
		expect(result.detail).toContain("Apply"); // the stuck action
		expect(acted).toHaveLength(3); // stops after the third identical failure, not 40
		expect(decideCalls).toBe(3);
	});

	it("hands off when the brain repeats one control with no progress (clicks 'succeed')", async () => {
		const acted: BrowserAction[] = [];
		const deps: ApplyDeps = {
			snapshot: async () => page('- button "Sign in"'),
			act: async (a) => { acted.push(a); return { url: "x", challenge: null }; }, // succeeds, no error
			decide: async () => ({ action: { action: "click", role: "button", name: "Sign in" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 40 });
		expect(result.outcome).toBe("stuck"); // fixation → handoff, not endless thrash
		expect(acted.length).toBe(3); // acted 3×, then handed off on the 4th identical decision before acting
	});

	it("does NOT treat repeated scrolls as fixation", async () => {
		let n = 0;
		const deps: ApplyDeps = {
			snapshot: async () => page("- text: long page"),
			act: async () => ({ url: "x", challenge: null }),
			decide: async () => (n++ < 8 ? { action: { action: "scroll", dy: 600 } } : { finish: { status: "blocked", detail: "done scrolling" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 40 });
		expect(result.outcome).toBe("blocked"); // scrolling many times is fine, no false handoff
	});

	it("feeds a failed action back into the log so the brain can adapt", async () => {
		const logsSeen: string[][] = [];
		let d = 0;
		const decisions: ApplyDecision[] = [
			{ action: { action: "click", role: "button", name: "Apply" } },
			{ action: { action: "click", role: "button", name: "Start" } },
			{ finish: { status: "submitted", detail: "done" } },
		];
		const deps: ApplyDeps = {
			snapshot: async () => page("page"),
			act: async () => (d === 1 ? { url: "x", challenge: null, error: "click timed out" } : { url: "x", challenge: null }),
			decide: async (p) => { logsSeen.push([...p.actionLog]); return decisions[Math.min(d++, decisions.length - 1)]; },
		};
		await runApplyLoop(deps, JOB, { maxSteps: 10 });
		// The 3rd decision sees the 2nd action recorded as FAILED.
		expect(logsSeen[2].some((l) => /FAILED: click timed out/.test(l))).toBe(true);
	});

	it("request_user_info → needs_input outcome (ask-and-hold), with the field", async () => {
		const deps: ApplyDeps = {
			snapshot: async () => page("- textbox \"Salary\""),
			act: async () => ({ url: "x", challenge: null }),
			decide: async () => ({ needsInput: { field: "salary expectation", why: "required field" } }),
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 10 });
		expect(result.outcome).toBe("needs_input");
		expect(result.fieldNeeded).toBe("salary expectation");
	});

	it("reports an event for every decision", async () => {
		const events: string[] = [];
		const { deps } = scriptedDeps([page("x"), page("done")], [{ action: { action: "click", name: "Apply" } }, { finish: { status: "submitted", detail: "ok" } }]);
		deps.onEvent = (type) => { events.push(type); };
		await runApplyLoop(deps, JOB, { maxSteps: 5 });
		expect(events.filter((e) => e === "agent.decision").length).toBe(2);
	});
});

describe("toolCallToDecision", () => {
	it("maps upload to the candidate's résumé path", () => {
		const d = toolCallToDecision({ name: "upload", arguments: { name: "CV" } }, JOB);
		expect(d.action).toEqual({ action: "upload", name: "CV", file: "/tmp/resume.pdf" });
	});
	it("maps finish and clamps an invalid status to blocked", () => {
		expect(toolCallToDecision({ name: "finish", arguments: { status: "submitted", detail: "done" } }, JOB).finish?.status).toBe("submitted");
		expect(toolCallToDecision({ name: "finish", arguments: { status: "weird", detail: "x" } }, JOB).finish?.status).toBe("blocked");
	});
	it("defaults select to a combobox role", () => {
		const d = toolCallToDecision({ name: "select", arguments: { name: "Country", value: "Australia" } }, JOB);
		expect(d.action).toMatchObject({ action: "select", role: "combobox", name: "Country", text: "Australia" });
	});
});
