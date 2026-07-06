import { describe, expect, it, vi } from "vitest";
import { listErrors, logError } from "./error-log.js";
import type { Env } from "../types.js";

function mockDb(rows: unknown[] = []) {
	const inserts: { sql: string; args: unknown[] }[] = [];
	const queries: string[] = [];
	const db = {
		prepare(sql: string) {
			queries.push(sql);
			return {
				// Bind-less .run() (used by the retention DELETE).
				run: async () => ({}),
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
		// logError writes error_log AND bridges a mirror row into agent_events.
		const errRow = inserts.find((i) => i.sql.includes("error_log"));
		expect(errRow).toBeDefined();
		const [, userId, source, status, message, context] = errRow!.args;
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

	it("opportunistically prunes old rows (retention)", async () => {
		const { env, queries } = mockDb();
		const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // force the 2% prune branch
		try {
			await logError(env, { source: "s", message: "m" });
		} finally {
			rnd.mockRestore();
		}
		expect(queries.some((q) => q.startsWith("DELETE FROM error_log") && q.includes("-30 days"))).toBe(true);
	});

	it("does NOT prune on the common path", async () => {
		const { env, queries } = mockDb();
		const rnd = vi.spyOn(Math, "random").mockReturnValue(0.5); // above the 0.02 threshold
		try {
			await logError(env, { source: "s", message: "m" });
		} finally {
			rnd.mockRestore();
		}
		expect(queries.some((q) => q.startsWith("DELETE FROM error_log"))).toBe(false);
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
