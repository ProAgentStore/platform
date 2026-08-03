import { describe, expect, it } from "vitest";
import { buildTicketAction, isRunnableStatus, readTicketAction, TICKET_ACTIONS, validateTicketAction } from "./actionable-ticket.js";

describe("readTicketAction", () => {
	it("reads the nested action a ticket stores", () => {
		const payload = { id: "t1", title: "Build a site", action: { action: "run_pipeline", config: { pipeline: "site-builder" }, params: { place_id: "p1" } } };
		expect(readTicketAction(payload)).toEqual({
			action: "run_pipeline",
			config: { pipeline: "site-builder" },
			params: { place_id: "p1" },
		});
	});

	it("reads the flat shape too (action/actionConfig/actionParams on the ticket)", () => {
		const payload = { id: "t1", action: "run_pipeline", actionConfig: { pipeline: "p" }, actionParams: { a: 1 } };
		expect(readTicketAction(payload)).toEqual({ action: "run_pipeline", config: { pipeline: "p" }, params: { a: 1 } });
	});

	it("defaults config/params to empty objects", () => {
		expect(readTicketAction({ action: { action: "add_knowledge" } })).toEqual({ action: "add_knowledge", config: {}, params: {} });
	});

	it("returns null for an ordinary informational ticket", () => {
		expect(readTicketAction({ id: "t1", title: "Found a lead", status: "completed" })).toBeNull();
	});

	it("returns null (not a throw) for an unknown or malformed action", () => {
		// A malformed payload must degrade to 'not actionable' rather than wedge the board.
		expect(readTicketAction({ action: { action: "rm_rf" } })).toBeNull();
		expect(readTicketAction({ action: { action: 42 } })).toBeNull();
		expect(readTicketAction("nope")).toBeNull();
		expect(readTicketAction(null)).toBeNull();
	});

	it("refuses sync_connector and log_event — a ticket carries agent work, not a sync", () => {
		expect(readTicketAction({ action: { action: "sync_connector" } })).toBeNull();
		expect(readTicketAction({ action: { action: "log_event" } })).toBeNull();
		expect(TICKET_ACTIONS).not.toContain("sync_connector");
		expect(TICKET_ACTIONS).not.toContain("log_event");
	});
});

describe("validateTicketAction", () => {
	it("accepts a plain ticket (no action at all)", () => {
		expect(validateTicketAction(undefined, undefined, undefined)).toBeNull();
		expect(validateTicketAction("", undefined, undefined)).toBeNull();
	});

	it("accepts a well-formed run_pipeline ticket", () => {
		expect(validateTicketAction("run_pipeline", { pipeline: "site-builder" }, { place_id: "p1" })).toBeNull();
	});

	it("takes the pipeline name from params when config omits it", () => {
		expect(validateTicketAction("run_pipeline", {}, { pipeline: "site-builder" })).toBeNull();
	});

	it("rejects run_pipeline with no pipeline name — it could never run", () => {
		expect(validateTicketAction("run_pipeline", {}, {})).toMatch(/config\.pipeline/);
	});

	it("rejects an unknown action", () => {
		expect(validateTicketAction("drop_database", {}, {})).toMatch(/must be one of/);
	});

	it("rejects non-object config/params", () => {
		expect(validateTicketAction("add_knowledge", "nope", {})).toMatch(/config must be an object/);
		expect(validateTicketAction("add_knowledge", {}, "nope")).toMatch(/params must be an object/);
	});
});

describe("isRunnableStatus", () => {
	it("allows the waiting/failed states", () => {
		for (const s of ["needs_approval", "queued", "blocked", "needs_human", "failed"]) expect(isRunnableStatus(s)).toBe(true);
	});

	it("blocks statuses that have already been decided", () => {
		for (const s of ["completed", "running", "cancelled", "", undefined, null]) expect(isRunnableStatus(s)).toBe(false);
	});
});

describe("buildTicketAction", () => {
	it("normalizes missing config/params to empty objects", () => {
		expect(buildTicketAction("run_pipeline", undefined, undefined)).toEqual({ action: "run_pipeline", config: {}, params: {} });
	});
});
