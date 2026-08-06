import { describe, expect, it } from "vitest";
import { applyMapping, extractPath, isValidPath, stringifyMapped, validateTriggerConfig } from "./trigger-config.js";

describe("extractPath", () => {
	const payload = {
		lead: { name: "Acme Pty Ltd", contact: { email: "hi@acme.test" } },
		items: [{ title: "First" }, { title: "Second" }],
		count: 3,
		flag: false,
		nothing: null,
	};

	it("reads nested object paths", () => {
		expect(extractPath(payload, "lead.name")).toBe("Acme Pty Ltd");
		expect(extractPath(payload, "lead.contact.email")).toBe("hi@acme.test");
	});

	it("indexes into arrays with a numeric segment", () => {
		expect(extractPath(payload, "items.1.title")).toBe("Second");
	});

	it("returns undefined for anything missing instead of throwing", () => {
		// A mapping that does not match THIS payload must fall back to the convention, not
		// fail the run — otherwise adding a mapping could break a working trigger.
		expect(extractPath(payload, "lead.phone")).toBeUndefined();
		expect(extractPath(payload, "items.9.title")).toBeUndefined();
		expect(extractPath(payload, "nothing.deep")).toBeUndefined();
		expect(extractPath(payload, "count.nope")).toBeUndefined();
		expect(extractPath(undefined, "lead.name")).toBeUndefined();
	});

	it("refuses paths outside the tiny grammar", () => {
		expect(isValidPath("lead.name")).toBe(true);
		expect(isValidPath("items.0.title")).toBe(true);
		expect(isValidPath("a b")).toBe(false);
		expect(isValidPath("lead..name")).toBe(false);
		expect(isValidPath("")).toBe(false);
		expect(extractPath(payload, "lead['name']")).toBeUndefined();
	});
});

describe("stringifyMapped", () => {
	it("renders scalars as text and objects as JSON", () => {
		expect(stringifyMapped("  hi  ")).toBe("hi");
		expect(stringifyMapped(3)).toBe("3");
		expect(stringifyMapped(false)).toBe("false");
		expect(stringifyMapped({ a: 1 })).toBe('{"a":1}');
		expect(stringifyMapped(null)).toBe("");
		expect(stringifyMapped(undefined)).toBe("");
	});
});

describe("applyMapping", () => {
	it("maps the action's fields off the payload", () => {
		const out = applyMapping({ lead: { name: "Acme", note: "urgent" } }, { title: "lead.name", description: "lead.note" }, "create_task");
		expect(out).toEqual({ title: "Acme", description: "urgent" });
	});

	it("omits fields whose path is absent so the caller's default still applies", () => {
		const out = applyMapping({ lead: { name: "Acme" } }, { title: "lead.name", description: "lead.note" }, "create_task");
		expect(out).toEqual({ title: "Acme" });
	});

	it("ignores targets that do not belong to the action", () => {
		// Defensive: rows written before the validator existed can carry anything.
		const out = applyMapping({ a: "x" }, { content: "a", title: "a" }, "create_task");
		expect(out).toEqual({ title: "x" });
	});

	it("returns nothing when no mapping is configured — the pre-existing behaviour", () => {
		expect(applyMapping({ title: "x" }, undefined, "create_task")).toEqual({});
		expect(applyMapping({ title: "x" }, "not-an-object", "create_task")).toEqual({});
	});
});

describe("validateTriggerConfig", () => {
	it("passes a correct config silently", () => {
		expect(validateTriggerConfig("create_task", "webhook", { title: "Lead", mapping: { title: "lead.name" } })).toEqual([]);
		expect(validateTriggerConfig("run_pipeline", "cron", { pipeline: "sweep" })).toEqual([]);
		expect(validateTriggerConfig("create_task", "webhook", undefined)).toEqual([]);
	});

	it("names a misspelled field rather than dropping it at dispatch", () => {
		// The bug this ticket is really about: `pipelin` was accepted, stored, echoed back, and
		// then silently discarded by the parseConfig whitelist — the trigger looked configured
		// and did nothing.
		const problems = validateTriggerConfig("run_pipeline", "cron", { pipelin: "sweep", pipeline: "sweep" });
		expect(problems.join(" ")).toContain('"pipelin"');
		expect(problems.join(" ")).toContain("ignored");
	});

	it("catches a well-spelled field that belongs to a DIFFERENT action", () => {
		const problems = validateTriggerConfig("create_task", "webhook", { collection: "leads" });
		expect(problems.join(" ")).toContain("not used by the create_task action");
	});

	it("flags cron-only config on a webhook trigger", () => {
		const problems = validateTriggerConfig("create_task", "webhook", { jitterMinutes: 5, timezone: "UTC" });
		expect(problems.join(" ")).toContain("only applies to cron triggers");
	});

	it("rejects an unknown timezone", () => {
		expect(validateTriggerConfig("create_task", "cron", { timezone: "Australia/Melbourn" }).join(" ")).toContain("not a known timezone");
		expect(validateTriggerConfig("create_task", "cron", { timezone: "Australia/Melbourne" })).toEqual([]);
	});

	it("bounds jitter and connector limit", () => {
		expect(validateTriggerConfig("create_task", "cron", { jitterMinutes: 5000 }).join(" ")).toContain("between 0 and 720");
		expect(validateTriggerConfig("sync_connector", "webhook", { limit: 99 }).join(" ")).toContain("between 1 and 20");
	});

	it("accepts the recursive-sync fields (#20) rather than silently dropping them", () => {
		expect(validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", recursive: true, maxDepth: 3, versioned: true })).toEqual([]);
	});

	it("says a maxDepth without recursion will do nothing — the sync would stay shallow", () => {
		const problems = validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", maxDepth: 3 });
		expect(problems.join(" ")).toContain('only applies when "recursive" is true');
	});

	it("bounds the traversal depth a sync may ask for", () => {
		expect(validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", recursive: true, maxDepth: 99 }).join(" "))
			.toContain("between 0 and 10");
	});

	it("rejects non-boolean recursive/versioned", () => {
		expect(validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", recursive: "yes" }).join(" "))
			.toContain("recursive must be true or false");
		expect(validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", versioned: 1 }).join(" "))
			.toContain("versioned must be true or false");
	});

	it("still refuses the sync fields on an action that does not read them", () => {
		expect(validateTriggerConfig("create_task", "cron", { recursive: true }).join(" ")).toContain("not used by the create_task action");
	});

	it("rejects a mapping onto a field the action does not have, naming the ones it does", () => {
		const problems = validateTriggerConfig("create_task", "webhook", { mapping: { content: "body.text" } });
		expect(problems.join(" ")).toContain('"content" is not a mappable field of create_task');
		expect(problems.join(" ")).toContain("title, description");
	});

	it("rejects a mapping path that is not a payload path", () => {
		expect(validateTriggerConfig("add_knowledge", "webhook", { mapping: { content: "body['text']" } }).join(" ")).toContain("payload path");
		expect(validateTriggerConfig("add_knowledge", "webhook", { mapping: { content: 12 } }).join(" ")).toContain("payload path");
	});

	it("says so when the action has nothing mappable at all", () => {
		expect(validateTriggerConfig("sync_connector", "cron", { provider: "google_drive", grantId: "g1", mapping: { title: "a" } }).join(" "))
			.toContain("no mappable fields");
	});

	it("requires action config on a CRON trigger, which has no payload to supply it", () => {
		expect(validateTriggerConfig("run_pipeline", "cron", {}).join(" ")).toContain("needs the pipeline name");
		expect(validateTriggerConfig("insert_record", "cron", {}).join(" ")).toContain("needs the target collection");
		expect(validateTriggerConfig("run_browse", "cron", { url: "not-a-url" }).join(" ")).toContain("http:// or https://");
		expect(validateTriggerConfig("sync_connector", "cron", {}).join(" ")).toContain("granted folder");
	});

	it("does NOT require it on a webhook, where the payload may legitimately carry it", () => {
		// dispatch prefers payload.pipeline over config.pipeline, so demanding config here would
		// break a working pattern.
		expect(validateTriggerConfig("run_pipeline", "webhook", {})).toEqual([]);
		expect(validateTriggerConfig("insert_record", "webhook", {})).toEqual([]);
	});

	it("accepts the pump's internal traceId without complaint", () => {
		expect(validateTriggerConfig("run_pipeline", "webhook", { pipeline: "x", traceId: "run-1" })).toEqual([]);
	});

	it("rejects a non-object config", () => {
		expect(validateTriggerConfig("create_task", "webhook", "nope")).toEqual(["config must be an object"]);
	});
});
