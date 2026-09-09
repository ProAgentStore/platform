import { describe, expect, it } from "vitest";
import type { McpEnv } from "./http.js";
import {
	listInstanceTouches,
	newTouchThrottle,
	RECENT_INSTANCE_TTL,
	recordInstanceTouch,
	TOUCH_WRITE_INTERVAL_MS,
	touchedInstance,
} from "./recent-instances.js";
import type { SafetyContext } from "./safety.js";

/**
 * The recorder behind `recent_instances` (#787): what it writes, under which key, and the two
 * cases it must stay silent in. The join against the roster and the run list is the tool's job
 * and is tested in `instance-tools.test.ts`; the wiring through the registration pipeline is
 * tested in `index.test.ts`, where the real `init()` runs.
 */

function makeKv() {
	const store = new Map<string, { value: string; ttl?: number }>();
	const kv = {
		get: async (k: string) => store.get(k)?.value ?? null,
		put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
			store.set(k, { value, ttl: opts?.expirationTtl });
		},
		list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true,
		}),
	} as unknown as KVNamespace;
	return { kv, store };
}

function ctxWith(kv: KVNamespace | undefined, subject?: string): SafetyContext {
	const env: McpEnv = { API_BASE: "https://api.test", ...(kv ? { OAUTH_KV: kv } : {}) };
	return { env, subject };
}

describe("touchedInstance — which instance a call was about", () => {
	it("reads the call's own instance_id", () => {
		expect(touchedInstance({ instance_id: "i1", run_id: "r1" })).toBe("i1");
	});

	it("prefers the pinned instance, which a pinned call never names in its arguments (#783)", () => {
		expect(touchedInstance({}, "pinned-1")).toBe("pinned-1");
		expect(touchedInstance({ instance_id: "i1" }, "pinned-1")).toBe("pinned-1");
	});

	it("reads nothing from agent_id or a party-to-the-call id, and nothing from an empty string", () => {
		expect(touchedInstance({ agent_id: "a1" })).toBeUndefined();
		expect(touchedInstance({ supervisor_instance_id: "s1" })).toBeUndefined();
		expect(touchedInstance({ instance_id: "" })).toBeUndefined();
		expect(touchedInstance(undefined)).toBeUndefined();
	});
});

describe("recordInstanceTouch", () => {
	it("writes one key per (subject, instance) with the tool, the time and the TTL", async () => {
		const { kv, store } = makeKv();
		const now = Date.parse("2026-09-09T10:00:00.000Z");
		await recordInstanceTouch(ctxWith(kv, "user-1"), "coding_loop_status", "i1", newTouchThrottle(), now);
		expect([...store.keys()]).toEqual(["recent:user-1:i1"]);
		expect(JSON.parse(store.get("recent:user-1:i1")!.value)).toEqual({
			instance: "i1",
			tool: "coding_loop_status",
			at: "2026-09-09T10:00:00.000Z",
		});
		expect(store.get("recent:user-1:i1")!.ttl).toBe(RECENT_INSTANCE_TTL);
	});

	it("throttles repeat writes for the same (subject, instance) inside the window, per instance", async () => {
		const { kv, store } = makeKv();
		const throttle = newTouchThrottle();
		const t0 = Date.parse("2026-09-09T10:00:00.000Z");
		const ctx = ctxWith(kv, "user-1");
		await recordInstanceTouch(ctx, "coding_loop_status", "i1", throttle, t0);
		// A second poll one second later is what KV's per-key write rate cannot absorb.
		await recordInstanceTouch(ctx, "coding_loop_status", "i1", throttle, t0 + 1_000);
		expect(JSON.parse(store.get("recent:user-1:i1")!.value).at).toBe("2026-09-09T10:00:00.000Z");
		// A different instance in the same second is a different key and is not throttled.
		await recordInstanceTouch(ctx, "coding_loop_status", "i2", throttle, t0 + 1_000);
		expect(store.has("recent:user-1:i2")).toBe(true);
		// Past the window the same instance is written again, with the later time.
		await recordInstanceTouch(ctx, "coding_timeline", "i1", throttle, t0 + TOUCH_WRITE_INTERVAL_MS);
		expect(JSON.parse(store.get("recent:user-1:i1")!.value)).toMatchObject({ tool: "coding_timeline", at: "2026-09-09T10:00:30.000Z" });
	});

	it("records nothing without an instance, a KV, or a subject", async () => {
		const { kv, store } = makeKv();
		await recordInstanceTouch(ctxWith(kv, "user-1"), "my_instances", undefined, newTouchThrottle());
		// No subject: an unverified per-call token must never become an identity (#702).
		await recordInstanceTouch(ctxWith(kv, undefined), "coding_loop_status", "i1", newTouchThrottle());
		expect(store.size).toBe(0);
		// No KV: a no-op, not a crash — the tool call this rides on must still answer.
		await expect(recordInstanceTouch(ctxWith(undefined, "user-1"), "coding_loop_status", "i1", newTouchThrottle())).resolves.toBeUndefined();
	});

	it("resolves a late-bound subject the same way audit() does", async () => {
		const { kv, store } = makeKv();
		const ctx: SafetyContext = { env: { API_BASE: "https://api.test", OAUTH_KV: kv }, resolveSubject: async () => "user-9" };
		await recordInstanceTouch(ctx, "coding_loop_status", "i1", newTouchThrottle());
		expect([...store.keys()]).toEqual(["recent:user-9:i1"]);
	});

	it("swallows a KV write failure — the hint never fails the call it rides on", async () => {
		const kv = {
			put: async () => {
				throw new Error("KV PUT failed: 429 Too Many Requests");
			},
		} as unknown as KVNamespace;
		await expect(recordInstanceTouch(ctxWith(kv, "user-1"), "coding_loop_status", "i1", newTouchThrottle())).resolves.toBeUndefined();
	});
});

describe("listInstanceTouches", () => {
	it("returns this subject's touches only, newest first, and skips a value it did not write", async () => {
		const { kv, store } = makeKv();
		const put = (k: string, v: unknown) => store.set(k, { value: typeof v === "string" ? v : JSON.stringify(v) });
		put("recent:user-1:i-old", { instance: "i-old", tool: "coding_loop_start", at: "2026-09-01T00:00:00.000Z" });
		put("recent:user-1:i-new", { instance: "i-new", tool: "coding_loop_status", at: "2026-09-09T00:00:00.000Z" });
		put("recent:user-1:i-mid", { instance: "i-mid", tool: "chat_with_instance", at: "2026-09-05T00:00:00.000Z" });
		put("recent:user-1:garbage", "not json");
		put("recent:user-2:theirs", { instance: "theirs", tool: "coding_loop_status", at: "2026-09-10T00:00:00.000Z" });
		put("audit:user-1:2026-09-09T00:00:00.000Z:x", { tool: "coding_loop_start", action: "completed" });
		const touches = await listInstanceTouches(ctxWith(kv, "user-1"));
		expect(touches.map((t) => t.instance)).toEqual(["i-new", "i-mid", "i-old"]);
	});

	it("is empty without a KV or a subject", async () => {
		const { kv, store } = makeKv();
		store.set("recent:user-1:i1", { value: JSON.stringify({ instance: "i1", tool: "x", at: "2026-09-09T00:00:00.000Z" }) });
		expect(await listInstanceTouches(ctxWith(undefined, "user-1"))).toEqual([]);
		expect(await listInstanceTouches(ctxWith(kv, undefined))).toEqual([]);
	});
});
