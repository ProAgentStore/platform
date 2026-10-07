import { describe, expect, it } from "vitest";
import { visibleSurfaces } from "./surfaces";
import { ACTION_LABEL, QUEUE_STATUS_LABEL, actionBody } from "./applications";
import type { ApplicationQueueItem } from "./types";

const base = { key: "app:a", kind: "application", status: "materials_ready", applicationId: "a", stateVersion: 3, scoutInstanceId: "s", leadId: "l", leadVersion: 1, actions: [] } as unknown as ApplicationQueueItem;

describe("the Applications tab's request shape (#958)", () => {
	it("sends the status and version it read — compare-and-set from the console too", () => {
		expect(actionBody(base, "archive")).toEqual({ action: "archive", expected_status: "materials_ready", application_id: "a", expected_version: 3 });
		const lead = { ...base, applicationId: null, status: "new", leadVersion: 0 } as ApplicationQueueItem;
		expect(actionBody(lead, "apply")).toEqual({ action: "apply", expected_status: "new", scout_instance_id: "s", record_id: "l", expected_version: 0 });
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
