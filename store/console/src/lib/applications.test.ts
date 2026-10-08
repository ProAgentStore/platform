import { describe, expect, it } from "vitest";
import { visibleSurfaces } from "./surfaces";
import { ACTION_LABEL, QUEUE_STATUS_LABEL, actionBody, actionLabel, confirmText } from "./applications";
import type { ApplicationQueueItem } from "./types";

const base = { key: "app:a", kind: "application", status: "materials_ready", applicationId: "a", stateVersion: 3, scoutInstanceId: "s", leadId: "l", leadVersion: 1, actions: [] } as unknown as ApplicationQueueItem;

describe("the Applications tab's request shape (#958)", () => {
	it("sends the status and version it read — compare-and-set from the console too", () => {
		expect(actionBody(base, "archive")).toEqual({ action: "archive", expected_status: "materials_ready", application_id: "a", expected_version: 3 });
		const lead = { ...base, applicationId: null, status: "new", leadVersion: 0 } as ApplicationQueueItem;
		expect(actionBody(lead, "apply")).toEqual({ action: "apply", expected_status: "new", scout_instance_id: "s", record_id: "l", expected_version: 0 });
	});
	it("the approval is named for what it does at THIS stage (#981)", () => {
		// Before the fill it proceeds; after it, the owner is looking at a populated form and it
		// continues. One action name, two labels — which is what keeps the board, this tab and MCP
		// offering exactly the same permitted action.
		expect(actionLabel("approve_and_proceed", "materials_ready")).toBe("Approve & proceed");
		expect(actionLabel("approve_and_proceed", "awaiting_review")).toBe("Approve & continue");
		expect(actionLabel("approve_and_proceed", "blocked")).toBe("Approve & continue");
		expect(actionLabel("retry_fill", "awaiting_review")).toBe(ACTION_LABEL.retry_fill);
		// Both stages confirm first, and the post-fill wording says what happens if the run has finished.
		expect(confirmText("approve_and_proceed", "materials_ready")).toMatch(/does not enable auto-submit/);
		expect(confirmText("approve_and_proceed", "awaiting_review")).toMatch(/Nothing is submitted twice/);
		expect(confirmText("defer", "awaiting_review")).toBeUndefined();
		// #991: `blocked` reaches the same wording, and it must not claim a form that does not exist —
		// the one-click refusal ends with `filled: 0`, so "this filled application" was untrue there.
		const blocked = confirmText("approve_and_proceed", "blocked") ?? "";
		expect(blocked).toMatch(/Approve THIS application/);
		expect(blocked).not.toMatch(/filled application/);
		expect(blocked).toMatch(/stopped at a control it may not press on its own/);
	});

	it("the approval's idempotency key follows the stage, so a retry reuses one authorization", () => {
		const filled = { ...base, status: "awaiting_review" } as ApplicationQueueItem;
		expect(actionBody(base, "approve_and_proceed").idempotency_key).toBe("approve:a:3");
		expect(actionBody(filled, "approve_and_proceed").idempotency_key).toBe("approve-continue:a:3");
	});

	it("labels every queue status and action, and names the submit control as one", () => {
		expect(Object.keys(QUEUE_STATUS_LABEL)).toHaveLength(12);
		expect(ACTION_LABEL.start_fill).toMatch(/submit/i);
		expect(ACTION_LABEL.request_review).not.toMatch(/submit/i);
	});
});

describe("the Applications tab is the Tailor's and the Runner's", () => {
	it("shows for local_artifact and local_apply agents, not for a Scout or a chat agent", () => {
		const ids = (caps: Parameters<typeof visibleSurfaces>[0]) => visibleSurfaces(caps).map((s) => s.id);
		expect(ids({ surfaces: [], runtime: "local_artifact" })).toContain("applications");
		expect(ids({ surfaces: [], runtime: "local_apply" })).toContain("applications");
		expect(ids({ surfaces: [], runtime: "local_browser" })).not.toContain("applications");
		expect(ids({ surfaces: [] })).not.toContain("applications");
	});
});
