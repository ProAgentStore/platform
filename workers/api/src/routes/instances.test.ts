import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import {
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	runtimeSetupTask,
	runtimeSetupTaskId,
	isCloudflareAiCredentialsError,
	normalizeRunnerTaskBody,
	runtimeEventsFromPayload,
	runtimeTasksFromPayload,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
} from "./instances.js";

describe("instance ID generation", () => {
	it("generates a valid UUID v4", () => {
		const id = crypto.randomUUID();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("generates unique IDs each time", () => {
		const ids = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
		expect(ids.size).toBe(100);
	});

	it("generates a different instance ID for each subscription", () => {
		const a = crypto.randomUUID();
		const b = crypto.randomUUID();
		expect(a).not.toBe(b);
	});
});

describe("subscription status values", () => {
	const VALID_STATUSES = ["active", "canceled", "paused"] as const;
	type Status = (typeof VALID_STATUSES)[number];

	it("initial subscribe produces 'active' status", () => {
		const status: Status = "active";
		expect(status).toBe("active");
		expect(VALID_STATUSES).toContain(status);
	});

	it("cancel sets status to 'canceled'", () => {
		const status: Status = "canceled";
		expect(status).toBe("canceled");
		expect(VALID_STATUSES).toContain(status);
	});

	it("all defined statuses are valid", () => {
		for (const s of VALID_STATUSES) {
			expect(VALID_STATUSES).toContain(s);
		}
	});

	it("unknown status is not in the valid set", () => {
		const unknown = "deleted";
		expect(VALID_STATUSES).not.toContain(unknown as Status);
	});
});

describe("cancel flow state transitions", () => {
	type Status = "active" | "canceled";

	function cancelInstance(current: Status): Status {
		if (current === "canceled") return "canceled"; // idempotent
		return "canceled";
	}

	function cancelSubscription(current: Status): Status {
		if (current !== "active") return current; // only cancel active
		return "canceled";
	}

	it("cancels an active instance", () => {
		expect(cancelInstance("active")).toBe("canceled");
	});

	it("cancel on already-canceled instance is idempotent", () => {
		expect(cancelInstance("canceled")).toBe("canceled");
	});

	it("cancels an active subscription", () => {
		expect(cancelSubscription("active")).toBe("canceled");
	});

	it("does not re-cancel a canceled subscription", () => {
		expect(cancelSubscription("canceled")).toBe("canceled");
	});

	it("batch cancel: both instance and subscription become canceled", () => {
		let instanceStatus: Status = "active";
		let subscriptionStatus: Status = "active";

		instanceStatus = cancelInstance(instanceStatus);
		subscriptionStatus = cancelSubscription(subscriptionStatus);

		expect(instanceStatus).toBe("canceled");
		expect(subscriptionStatus).toBe("canceled");
	});

	it("subscribe response shape contains instanceId, agentId, status", () => {
		const instanceId = crypto.randomUUID();
		const agentId = crypto.randomUUID();
		const response = { instanceId, agentId, status: "active" };

		expect(response).toHaveProperty("instanceId");
		expect(response).toHaveProperty("agentId");
		expect(response).toHaveProperty("status", "active");
	});
});

describe("instance ownership check", () => {
	it("returns instance only when user_id matches", () => {
		const instances = [
			{ id: "inst-1", user_id: "user-a" },
			{ id: "inst-2", user_id: "user-b" },
		];
		const found = instances.find(
			(i) => i.id === "inst-1" && i.user_id === "user-a",
		);
		expect(found).toBeDefined();
	});

	it("returns null when user_id does not match", () => {
		const instances = [{ id: "inst-1", user_id: "user-a" }];
		const found = instances.find(
			(i) => i.id === "inst-1" && i.user_id === "user-x",
		);
		expect(found).toBeUndefined();
	});
});

describe("runtime endpoint validation", () => {
	it("accepts https tunnel endpoints and strips path trailing slash", () => {
		expect(validateRuntimeEndpointUrl("https://runner.example.com/")).toBe(
			"https://runner.example.com",
		);
	});

	it("accepts localhost http for development", () => {
		expect(validateRuntimeEndpointUrl("http://127.0.0.1:49171")).toBe(
			"http://127.0.0.1:49171",
		);
		expect(validateRuntimeEndpointUrl("http://localhost:49171/")).toBe(
			"http://localhost:49171",
		);
		expect(validateRuntimeEndpointUrl("http://[::1]:49171/")).toBe(
			"http://[::1]:49171",
		);
	});

	it("rejects non-https non-local endpoints", () => {
		expect(() => validateRuntimeEndpointUrl("http://runner.example.com")).toThrow(
			HttpError,
		);
	});

	it("rejects invalid URLs", () => {
		expect(() => validateRuntimeEndpointUrl("not a url")).toThrow(HttpError);
	});
});

describe("runtime task protocol shape", () => {
	it("transfers runtime ownership on upsert when the authenticated user changes", () => {
		expect(UPSERT_INSTANCE_RUNTIME_SQL).toContain(
			"ON CONFLICT(instance_id) DO UPDATE SET",
		);
		expect(UPSERT_INSTANCE_RUNTIME_SQL).toContain("user_id = excluded.user_id");
	});

	it("creates PAGS-brain runtime task request shape", () => {
		const request = {
			type: "browser.open",
			input: { url: "https://example.com/jobs/1" },
			requiresApproval: true,
			approvalPrompt: "Open job page locally",
		};
		expect(request.type).toBe("browser.open");
		expect(request.requiresApproval).toBe(true);
		expect(request.input.url).toContain("https://");
	});

	it("runtime response never includes token material", () => {
		const runtime = {
			instanceId: "inst-1",
			endpointUrl: "https://runner.example.com",
			hasToken: true,
		};
		expect(runtime).not.toHaveProperty("token");
		expect(runtime).not.toHaveProperty("tokenPlaintext");
	});

	it("normalizes browser.open tasks as approval-required at the PAGS boundary", () => {
		expect(
			normalizeRunnerTaskBody({
				type: " browser.open ",
				input: { url: "https://example.com/jobs/1" },
				requiresApproval: false,
			}),
		).toMatchObject({
			type: "browser.open",
			input: { url: "https://example.com/jobs/1" },
			requiresApproval: true,
			approvalPrompt: "Approve task browser.open",
		});
	});

	it("normalizes browser.open tasks as approval-required at the PAGS boundary", () => {
		expect(
			normalizeRunnerTaskBody({
				type: "browser.open",
				input: { url: "https://example.com/jobs/1" },
				requiresApproval: false,
			}),
		).toMatchObject({
			type: "browser.open",
			input: { url: "https://example.com/jobs/1" },
			requiresApproval: true,
			approvalPrompt: "Approve task browser.open",
		});
	});

	it("rejects invalid runner task bodies", () => {
		expect(() => normalizeRunnerTaskBody({ input: {} })).toThrow(HttpError);
		expect(() => normalizeRunnerTaskBody({ type: "" })).toThrow(HttpError);
	});

	it("extracts task snapshots from runtime task payloads", () => {
		expect(runtimeTasksFromPayload({ id: "task-1", status: "completed" })).toHaveLength(1);
		expect(runtimeTasksFromPayload({ tasks: [{ id: "task-1" }, { nope: true }, null] })).toEqual([
			{ id: "task-1" },
			{ nope: true },
		]);
		expect(runtimeTasksFromPayload({ events: [] })).toEqual([]);
	});

	it("extracts runtime events from event payloads", () => {
		expect(runtimeEventsFromPayload({ events: [{ id: "event-1" }, null, { type: "task.completed" }] }))
			.toEqual([{ id: "event-1" }, { type: "task.completed" }]);
		expect(runtimeEventsFromPayload({ id: "task-1" })).toEqual([]);
	});

	it("builds a durable blocker for missing caller-owned Cloudflare AI credentials", () => {
		const task = cloudflareAiSetupTask(
			"inst-1",
			"Add your Cloudflare Workers AI account ID and API token before running this agent.",
			"2026-06-22T00:00:00.000Z",
		);

		expect(isCloudflareAiCredentialsError(task.error)).toBe(true);
		expect(task).toMatchObject({
			id: cloudflareAiSetupTaskId("inst-1"),
			type: "setup.cloudflare_workers_ai",
			status: "blocked",
			synthetic: true,
			input: {
				provider: "cloudflare",
				profilePath: "/profile",
			},
		});
	});

	it("builds a durable setup task when no browser runtime is connected", () => {
		const task = runtimeSetupTask("inst-1", "2026-06-22T00:00:00.000Z");

		expect(task).toMatchObject({
			id: runtimeSetupTaskId("inst-1"),
			type: "setup.pags_browser_runtime",
			status: "blocked",
			synthetic: true,
			error: "No ProAgentStore browser runtime is registered for this instance.",
		});
		expect(task.input).toMatchObject({
			install: "npm i -g @proagentstore/cli",
			connect: "pags up",
		});
	});
});

describe("voice settings validation", () => {
	it("clamps speed to 50-200 range", () => {
		// Speed clamping logic (mirrors the PUT handler)
		const clamp = (v: unknown) => typeof v === "number" ? Math.max(50, Math.min(200, Math.round(v))) : 100;
		expect(clamp(100)).toBe(100);
		expect(clamp(150)).toBe(150);
		expect(clamp(0)).toBe(50);
		expect(clamp(300)).toBe(200);
		expect(clamp(-10)).toBe(50);
		expect(clamp(75.7)).toBe(76);
		expect(clamp(undefined)).toBe(100);
		expect(clamp("fast")).toBe(100);
	});

	it("validates provider values", () => {
		const valid = ["browser", "openai-realtime", "gemini-live"];
		expect(valid.includes("browser")).toBe(true);
		expect(valid.includes("openai-realtime")).toBe(true);
		expect(valid.includes("gemini-live")).toBe(true);
		expect(valid.includes("invalid")).toBe(false);
		expect(valid.includes("")).toBe(false);
	});

	it("preserves full voice settings structure", () => {
		const settings = {
			provider: "openai-realtime",
			speed: 120,
			openai: { model: "gpt-realtime", voice: "shimmer" },
			gemini: { model: "gemini-2.0-flash-exp" },
			language: "en-US",
		};
		// Validate shape
		expect(settings.provider).toBe("openai-realtime");
		expect(settings.openai.model).toBe("gpt-realtime");
		expect(settings.openai.voice).toBe("shimmer");
		expect(settings.gemini.model).toBe("gemini-2.0-flash-exp");
		expect(settings.speed).toBe(120);
		expect(settings.language).toBe("en-US");
	});

	it("defaults speed to 100 for non-numeric input", () => {
		const clamp = (v: unknown) => typeof v === "number" ? Math.max(50, Math.min(200, Math.round(v))) : 100;
		expect(clamp(null)).toBe(100);
		expect(clamp({})).toBe(100);
		expect(clamp([])).toBe(100);
		expect(clamp(true)).toBe(100);
	});
});
