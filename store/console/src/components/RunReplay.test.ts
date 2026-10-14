/**
 * The shared replay player (#1063): one component for a workflow task, a Scout research run and an
 * Application Runner fill. Frames come from the subject's stored artifacts; a workflow task's older
 * screenshots (no artifact id) still play from their original route.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type BrowserArtifactView, type ReplaySubjectKind, artifactCaption, replayFrames } from "../lib/runReplay";
import RunReplay from "./RunReplay";

const artifact = (subjectKind: ReplaySubjectKind, seq: number, over: Partial<BrowserArtifactView> = {}): BrowserArtifactView => ({
	id: `art-${subjectKind}-${seq}`,
	subjectKind,
	subjectId: "run-1",
	seq,
	contentType: "image/jpeg",
	bytes: 1234,
	point: "navigated",
	url: "https://au.seek.com/job/1",
	domain: "au.seek.com",
	action: null,
	createdAt: "2026-10-14T00:00:00.000Z",
	...over,
});

describe("replayFrames", () => {
	it("plays a subject's artifacts in seq order, fetched from the owner-checked route", () => {
		const frames = replayFrames("i1", [artifact("local_browser_run", 2, { point: "snapshot" }), artifact("local_browser_run", 1)]);
		expect(frames.map((f) => [f.seq, f.caption, f.src])).toEqual([
			[1, "Opened a page — au.seek.com", "/v1/instances/i1/browser-artifacts/art-local_browser_run-1"],
			[2, "Read the page — au.seek.com", "/v1/instances/i1/browser-artifacts/art-local_browser_run-2"],
		]);
	});

	it("a workflow task merges its stored frames with older shots that predate the contract — no duplicates", () => {
		const frames = replayFrames("i1", [artifact("runtime_task", 3, { point: "action", action: "click" })], {
			taskId: "task-1",
			shots: [
				{ seq: 1, msg: "Opened the job page" },
				{ seq: 3, artifactId: "art-runtime_task-3", msg: "Clicked Apply" },
			],
		});
		expect(frames.map((f) => [f.seq, f.caption, f.src])).toEqual([
			[1, "Opened the job page", "/v1/instances/i1/tasks/task-1/shots/1"],
			[3, "Clicked Apply", "/v1/instances/i1/browser-artifacts/art-runtime_task-3"],
		]);
	});

	it("a caption is built from metadata only — what happened and where, never page text", () => {
		expect(artifactCaption({ point: "filled", domain: "jobs.example.com", action: null })).toBe("Filled a field — jobs.example.com");
		expect(artifactCaption({ point: "something_new", domain: null, action: null })).toBe("Acted on the page");
	});
});

describe("<RunReplay> renders for every subject kind", () => {
	it.each(["runtime_task", "local_browser_run", "local_apply_run"] as const)("%s: controls, counter and the first frame's caption", (kind) => {
		const html = renderToStaticMarkup(createElement(RunReplay, { frames: replayFrames("i1", [artifact(kind, 1), artifact(kind, 2, { point: "completed" })]), emptyText: "none" }));
		expect(html).toContain('data-testid="run-replay"');
		for (const label of ["Play", "Previous", "Next", "Step"]) expect(html).toContain(`aria-label="${label}"`);
		expect(html).toContain("1/2");
		expect(html).toContain("Opened a page — au.seek.com");
		// Bytes are fetched with the owner's token after mount; nothing is inlined in the markup.
		expect(html).toContain("Loading screenshot…");
		expect(html).not.toMatch(/src="data:|browser-artifacts\//);
	});

	it("says so when a run has no frames", () => {
		const html = renderToStaticMarkup(createElement(RunReplay, { frames: [], emptyText: "No screenshots for this run." }));
		expect(html).toContain('data-testid="replay-empty"');
		expect(html).toContain("No screenshots for this run.");
	});
});
