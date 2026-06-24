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

	it("breaks the loop after the same action fails 3× (no infinite retry)", async () => {
		const acted: BrowserAction[] = [];
		let decideCalls = 0;
		const deps: ApplyDeps = {
			snapshot: async () => page("- button \"Apply\""),
			act: async (a) => { acted.push(a); return { url: "x", challenge: null, error: "Timeout 10000ms exceeded" }; },
			decide: async () => { decideCalls++; return { action: { action: "click", role: "button", name: "Apply" } }; },
		};
		const result = await runApplyLoop(deps, JOB, { maxSteps: 40 });
		expect(result.outcome).toBe("failed");
		expect(result.detail).toMatch(/3×/);
		expect(acted).toHaveLength(3); // stops after the third identical failure, not 40
		expect(decideCalls).toBe(3);
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
