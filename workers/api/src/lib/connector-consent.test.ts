import { describe, expect, it } from "vitest";
import { consentModeFor, ensureConsent, hasConsent, setConsent, revokeConsent, listConsents, listAllConsents } from "./connector-consent.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

/** A mock D1 that records writes and returns canned first()/all() results. */
function mockEnv(opts: { first?: unknown; all?: unknown[]; throwOnFirst?: boolean } = {}): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			const first = async () => {
				if (opts.throwOnFirst) throw new Error("db down");
				return opts.first ?? null;
			};
			const all = async () => ({ results: opts.all ?? [] });
			return {
				// listAllConsents calls .all() directly (no .bind())
				all,
				first,
				bind(...args: unknown[]) {
					return {
						async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
						all,
						first,
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("hasConsent", () => {
	it("returns true when a matching consent row exists", async () => {
		const { env } = mockEnv({ first: { ok: 1 } });
		expect(await hasConsent(env, "inst-1", "github", "write")).toBe(true);
	});

	it("returns false when no row exists", async () => {
		const { env } = mockEnv({ first: null });
		expect(await hasConsent(env, "inst-1", "github", "write")).toBe(false);
	});

	it("fail-closed: returns false when instanceId is missing (no DB hit)", async () => {
		const { env, writes } = mockEnv({ first: { ok: 1 } });
		expect(await hasConsent(env, undefined, "github", "write")).toBe(false);
		expect(writes).toHaveLength(0); // short-circuited before touching the DB
	});

	it("fail-closed: swallows a DB error and returns false", async () => {
		const { env } = mockEnv({ throwOnFirst: true });
		expect(await hasConsent(env, "inst-1", "github", "write")).toBe(false);
	});

	it("scopes the query by instance + connector + scope", async () => {
		// captured via a bespoke DB to assert the exact bound args
		const captured: Write[] = [];
		const scopedEnv = {
			DB: {
				prepare(sql: string) {
					return { bind(...args: unknown[]) { return { async first() { captured.push({ sql, args }); return { ok: 1 }; } }; } };
				},
			},
		} as unknown as Env;
		await hasConsent(scopedEnv, "inst-9", "whatsapp", "write");
		expect(captured[0].sql).toContain("instance_connector_consent");
		expect(captured[0].args).toEqual(["inst-9", "whatsapp", "write"]);
	});
});

describe("setConsent", () => {
	it("upserts with the 5 bound values, defaulting the mode to always", async () => {
		const { env, writes } = mockEnv();
		await setConsent(env, "inst-1", "user-1", "github", "write");
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("INSERT INTO instance_connector_consent");
		expect(writes[0].sql).toContain("ON CONFLICT");
		expect(writes[0].args).toEqual(["inst-1", "user-1", "github", "write", "always"]);
	});

	// It became an UPDATE at #722: setting a mode on a connector already granted has to change the
	// stored row, and DO NOTHING would have made "Ask each time" silently fail to save on exactly
	// the connectors that already had a grant — i.e. every one a user would want to narrow.
	it("UPDATEs the mode of a row that already exists (this is the explicit path)", async () => {
		const { env, writes } = mockEnv();
		await setConsent(env, "inst-1", "user-1", "github", "write", "ask");
		expect(writes[0].sql).toContain("DO UPDATE SET mode = excluded.mode");
		expect(writes[0].args).toEqual(["inst-1", "user-1", "github", "write", "ask"]);
	});
});

describe("ensureConsent (the IMPLIED grant — #722)", () => {
	// Granting one MCP server satisfies the outer `mcp` write gate as a side effect. With
	// setConsent's upsert that side effect would also reset a connector the owner had deliberately
	// set to "Ask each time" back to "Always allow" — a gate removed by an unrelated click.
	it("INSERTs as always, and leaves an existing row's mode alone", async () => {
		const { env, writes } = mockEnv();
		await ensureConsent(env, "inst-1", "user-1", "mcp", "write");
		expect(writes[0].sql).toContain("ON CONFLICT");
		expect(writes[0].sql).toContain("DO NOTHING");
		expect(writes[0].sql).not.toContain("DO UPDATE");
		expect(writes[0].args).toEqual(["inst-1", "user-1", "mcp", "write"]);
	});
});

describe("consentModeFor (#722)", () => {
	it("reads the stored mode", async () => {
		const { env } = mockEnv({ first: { mode: "ask" } });
		expect(await consentModeFor(env, "inst-1", "gmail", "write")).toBe("ask");
	});

	it("is null — not a mode — when there is no row, so the gate stays fail-closed", async () => {
		const { env } = mockEnv({ first: null });
		expect(await consentModeFor(env, "inst-1", "gmail", "write")).toBeNull();
	});

	it("reads an unrecognised stored value as `always`… and that is the SAFE end", async () => {
		// Deliberate, and worth stating because it looks like the wrong direction. `always` is what
		// every pre-0155 row means and what the column defaults to, so an unreadable value is much
		// more likely to be a legacy row than a corrupted "ask". Reading it as `ask` would silently
		// queue writes for agents nobody had opted in — the regression the whole migration is
		// designed to avoid. Refusal for a genuinely missing grant is still handled above, by null.
		const { env } = mockEnv({ first: { mode: "whatever" } });
		expect(await consentModeFor(env, "inst-1", "gmail", "write")).toBe("always");
	});

	it("an ask-mode grant still counts as CONSENTED — queued is not ungranted", async () => {
		const { env } = mockEnv({ first: { mode: "ask" } });
		expect(await hasConsent(env, "inst-1", "gmail", "write")).toBe(true);
	});
});

describe("revokeConsent", () => {
	it("DELETEs the matching consent row, scoped by instance+connector+scope (not user)", async () => {
		const { env, writes } = mockEnv();
		await revokeConsent(env, "inst-1", "github", "write");
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("DELETE FROM instance_connector_consent");
		expect(writes[0].args).toEqual(["inst-1", "github", "write"]);
	});
});

describe("listConsents", () => {
	it("returns the rows for one instance", async () => {
		const rows = [{ instance_id: "inst-1", user_id: "u1", connector: "github", scope: "write", mode: "ask", created_at: "2026-08-01" }];
		const { env } = mockEnv({ all: rows });
		expect(await listConsents(env, "inst-1")).toEqual(rows);
	});

	it("returns [] when the query yields no results", async () => {
		const { env } = mockEnv({ all: [] });
		expect(await listConsents(env, "inst-1")).toEqual([]);
	});
});

describe("listAllConsents", () => {
	it("returns every consent joined with the owner login", async () => {
		const rows = [{ instance_id: "inst-1", user_id: "u1", connector: "github", scope: "write", mode: "always", created_at: "2026-08-01", owner_login: "alice" }];
		const { env } = mockEnv({ all: rows });
		const out = await listAllConsents(env);
		expect(out).toEqual(rows);
		expect(out[0].owner_login).toBe("alice");
	});
});
