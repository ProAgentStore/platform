import { describe, expect, it } from "vitest";
import { listErrors, logError } from "./error-log.js";
import type { Env } from "../types.js";

function mockDb(rows: unknown[] = []) {
	const inserts: { sql: string; args: unknown[] }[] = [];
	const queries: string[] = [];
	const db = {
		prepare(sql: string) {
			queries.push(sql);
			return {
				bind(...args: unknown[]) {
					return {
						run: async () => { if (sql.startsWith("INSERT")) inserts.push({ sql, args }); return {}; },
						all: async () => ({ results: rows }),
						first: async () => rows[0] ?? null,
					};
				},
			};
		},
	};
	return { env: { DB: db } as unknown as Env, inserts, queries };
}

describe("logError", () => {
	it("persists source, status, message, and JSON context", async () => {
		const { env, inserts } = mockDb();
		await logError(env, { source: "keys-proxy", userId: "u1", status: 400, message: "boom", context: { host: "api.openai.com" } });
		expect(inserts).toHaveLength(1);
		const [, userId, source, status, message, context] = inserts[0].args;
		expect(userId).toBe("u1");
		expect(source).toBe("keys-proxy");
		expect(status).toBe(400);
		expect(message).toBe("boom");
		expect(JSON.parse(context as string)).toEqual({ host: "api.openai.com" });
	});

	it("never throws even if the DB blows up", async () => {
		const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
		await expect(logError(env, { source: "x", message: "y" })).resolves.toBeUndefined();
	});

	it("bounds oversized message and context", async () => {
		const { env, inserts } = mockDb();
		await logError(env, { source: "s", message: "m".repeat(5000), context: { big: "c".repeat(9000) } });
		expect((inserts[0].args[4] as string).length).toBe(2000);
		expect((inserts[0].args[5] as string).length).toBe(4000);
	});
});

describe("listErrors", () => {
	it("scopes to the user by default", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { userId: "u1" });
		expect(queries[0]).toContain("WHERE user_id = ?1");
	});

	it("returns everyone's when all=true (no user filter)", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { all: true });
		expect(queries[0]).not.toContain("WHERE");
	});

	it("adds a source filter", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { userId: "u1", source: "auth" });
		expect(queries[0]).toContain("user_id = ?1");
		expect(queries[0]).toContain("source = ?2");
	});
});
