import { describe, expect, it, vi } from "vitest";
import { logUnhandled } from "./on-error.js";
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
});
