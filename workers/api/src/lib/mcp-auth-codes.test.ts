import { describe, expect, it } from "vitest";
import { mintMcpAuthCode, exchangeMcpAuthCode } from "./mcp-auth-codes.js";
import type { Env } from "../types.js";

// Minimal in-memory D1 that understands exactly the 3 statements mcp-auth-codes issues:
// INSERT, the cleanup DELETE (expires_at < ?), and the atomic exchange DELETE … RETURNING.
function fakeDb() {
	const rows = new Map<string, { session: string; expires_at: number }>();
	const prepare = (sql: string) => {
		let args: unknown[] = [];
		const stmt = {
			bind(...a: unknown[]) { args = a; return stmt; },
			async run() {
				if (sql.includes("INSERT")) rows.set(String(args[0]), { session: String(args[1]), expires_at: Number(args[2]) });
				else if (sql.includes("DELETE") && sql.includes("expires_at < ")) {
					const now = Number(args[0]);
					for (const [k, v] of rows) if (v.expires_at < now) rows.delete(k);
				}
				return {};
			},
			async first<T>(): Promise<T | null> {
				if (sql.includes("DELETE") && sql.includes("RETURNING")) {
					const hash = String(args[0]);
					const now = Number(args[1]);
					const r = rows.get(hash);
					if (r && r.expires_at > now) { rows.delete(hash); return { session: r.session } as T; }
				}
				return null;
			},
		};
		return stmt;
	};
	return { db: { prepare } as unknown as Env["DB"], rows };
}
const env = (db: Env["DB"]) => ({ DB: db }) as Env;

describe("mcp-auth-codes (#25 — one-time code, never a token in the URL)", () => {
	it("mints a code that exchanges once for its session", async () => {
		const { db } = fakeDb();
		const code = await mintMcpAuthCode(env(db), "sess-abc");
		expect(code).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
		expect(await exchangeMcpAuthCode(env(db), code)).toBe("sess-abc");
	});

	it("is single-use — a second exchange fails closed (no double-mint)", async () => {
		const { db } = fakeDb();
		const code = await mintMcpAuthCode(env(db), "sess-abc");
		expect(await exchangeMcpAuthCode(env(db), code)).toBe("sess-abc");
		expect(await exchangeMcpAuthCode(env(db), code)).toBeNull();
	});

	it("fails closed on an unknown / empty code", async () => {
		const { db } = fakeDb();
		expect(await exchangeMcpAuthCode(env(db), "deadbeef")).toBeNull();
		expect(await exchangeMcpAuthCode(env(db), "")).toBeNull();
	});

	it("fails closed on an expired code", async () => {
		const { db, rows } = fakeDb();
		const code = await mintMcpAuthCode(env(db), "sess-abc");
		for (const [, v] of rows) v.expires_at = 0; // force-expire the stored row
		expect(await exchangeMcpAuthCode(env(db), code)).toBeNull();
	});
});
