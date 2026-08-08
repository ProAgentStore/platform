import { describe, expect, it } from "vitest";
import { isTransientInfraError, logUnhandled } from "./on-error.js";
import { HttpError } from "./auth.js";
import type { Env } from "../types.js";

/** Mock env whose DB records every prepare() SQL + its bind args. logError also
 *  mirrors to agent_events, so we filter to the error_log insert in each test. */
function mockEnv() {
	const calls: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						calls.push({ sql, args });
						return { run: async () => ({}) };
					},
				};
			},
		},
	} as unknown as Env;
	const errorLogBinds = () => calls.filter((c) => c.sql.includes("INSERT INTO error_log")).map((c) => c.args);
	return { env, errorLogBinds };
}

const req = { path: "/v1/agents/x/chat", method: "POST" };

describe("logUnhandled", () => {
	it("logs a genuine exception with full message + stack in context", async () => {
		const { env, errorLogBinds } = mockEnv();
		const err = new Error("boom kaboom");
		await logUnhandled(env, err, req);
		const binds = errorLogBinds();
		// error_log INSERT binds: [id, userId, source, status, message, contextJSON]
		expect(binds.length).toBe(1);
		const [, , source, status, message, contextJSON] = binds[0];
		expect(source).toBe("unhandled");
		expect(status).toBe(500);
		expect(message).toBe("Error: boom kaboom");
		const ctx = JSON.parse(contextJSON as string);
		expect(ctx.path).toBe("/v1/agents/x/chat");
		expect(ctx.method).toBe("POST");
		expect(typeof ctx.stack).toBe("string");
		expect(ctx.stack.length).toBeGreaterThan(0);
	});

	it("does NOT log a 4xx HttpError (expected client error)", async () => {
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, new HttpError(404, "Agent not found"), req);
		const binds = errorLogBinds();
		expect(binds.length).toBe(0);
	});

	it("logs a 5xx HttpError (real server failure)", async () => {
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, new HttpError(502, "upstream down"), req);
		const binds = errorLogBinds();
		expect(binds.length).toBe(1);
		expect(binds[0][3]).toBe(502); // status
		expect(binds[0][4]).toBe("upstream down");
	});

	it("never throws even if the DB insert fails", async () => {
		const env = { DB: { prepare() { throw new Error("db gone"); } } } as unknown as Env;
		await expect(logUnhandled(env, new Error("x"), req)).resolves.toBeUndefined();
	});

	it("stringifies non-Error throws", async () => {
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, "plain string boom", req);
		const binds = errorLogBinds();
		expect(binds[0][4]).toBe("plain string boom");
	});

	it("attributes the failure to the signed-in user", async () => {
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, new Error("boom"), { ...req, userId: "google:123" });
		// error_log INSERT binds: [id, userId, source, status, message, contextJSON]
		expect(errorLogBinds()[0][1]).toBe("google:123");
	});

	it("RECORDS a transient infra error as a warn under its own source (#424)", async () => {
		// It used to return before writing anything. That was right about severity — a DO reset by
		// a deploy self-heals and the 503 is the correct answer — and wrong about visibility: it
		// made "how often does a deploy break a live request?" unanswerable, which is the question
		// that was actually asked. The one occurrence on record exists only because a browser
		// reported it from the other side; a runner or the MCP server would have left nothing.
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, new Error("Durable Object reset because its code was updated."), req);
		const binds = errorLogBinds();
		expect(binds.length).toBe(1);
		// [id, userId, source, status, message, contextJSON, level]
		expect(binds[0][2]).toBe("transient");
		expect(binds[0][3]).toBe(503);
		expect(binds[0][6]).toBe("warn");
		// A distinct source, so deploy disruption is countable with `?source=transient` rather than
		// by matching platform wording that is not ours and can change under us.
		expect(JSON.parse(binds[0][5] as string).path).toBe("/v1/agents/x/chat");
	});

	it("records the diagnostic 4xx at warn, and still drops 401/404", async () => {
		// 402 no key connected · 403 a permission wall · 409 a conflicting write · 429 a user
		// repeatedly hitting a limit. Those are evidence. 401/404 on an SPA are background traffic
		// and logging them would flood the log harder than #423's cron did.
		for (const status of [402, 403, 409, 429]) {
			const { env, errorLogBinds } = mockEnv();
			await logUnhandled(env, new HttpError(status, `wall ${status}`), req);
			const binds = errorLogBinds();
			expect(binds.length, `status ${status}`).toBe(1);
			expect(binds[0][3], `status ${status}`).toBe(status);
			expect(binds[0][6], `status ${status}`).toBe("warn");
		}
		for (const status of [400, 401, 404, 422]) {
			const { env, errorLogBinds } = mockEnv();
			await logUnhandled(env, new HttpError(status, "expected"), req);
			expect(errorLogBinds().length, `status ${status}`).toBe(0);
		}
	});

	it("keeps 5xx and unhandled exceptions at error level", async () => {
		// The whole point of `warn` is that it does NOT dilute the error count. A regression that
		// filed a real 500 as a warn would hide it from the default operator read.
		const { env, errorLogBinds } = mockEnv();
		await logUnhandled(env, new HttpError(502, "upstream down"), req);
		await logUnhandled(env, new Error("boom"), req);
		expect(errorLogBinds().map((b) => b[6])).toEqual(["error", "error"]);
	});
});

describe("isTransientInfraError", () => {
	it("matches the platform's transient infra messages", () => {
		expect(isTransientInfraError(new Error("Durable Object reset because its code was updated."))).toBe(true);
		expect(isTransientInfraError(new Error("Durable Object is overloaded."))).toBe(true);
		expect(isTransientInfraError(new Error("Network connection lost."))).toBe(true);
	});
	it("does not match real bugs", () => {
		expect(isTransientInfraError(new Error("Cannot read properties of undefined"))).toBe(false);
		expect(isTransientInfraError(new HttpError(500, "boom"))).toBe(false);
		expect(isTransientInfraError("some string")).toBe(false);
	});
});
