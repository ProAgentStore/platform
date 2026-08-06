import { describe, expect, it } from "vitest";
import {
	PLATFORM_AI_KEY,
	platformAiBinding,
	platformAiEnabled,
	readPlatformAiSetting,
	setPlatformAiOverride,
} from "./platform-settings.js";
import type { Env } from "../types.js";

/**
 * The platform-paid AI kill switch (#46). The properties under test are the ones an
 * operator's incident depends on: the override beats the deploy-time env var, clearing
 * it hands control back, and nothing here is ever cached.
 */

interface DbOpts {
	row?: { value: string; updated_at?: string; updated_by?: string } | null;
	throws?: boolean;
}

/** Stateful D1 stand-in for the one-row platform_settings table. */
function makeEnv(envDefault: boolean, opts: DbOpts = {}) {
	let row = opts.row === undefined ? null : opts.row;
	const writes: Array<{ sql: string; binds: unknown[] }> = [];
	const env = {
		PLATFORM_AI_ENABLED: envDefault ? "true" : "false",
		AI: { run: async () => ({}) },
		DB: {
			prepare(sql: string) {
				const exec = (binds: unknown[]) => {
					if (opts.throws) throw new Error("D1 unavailable");
					if (sql.startsWith("SELECT")) return row;
					writes.push({ sql, binds });
					if (sql.startsWith("DELETE")) row = null;
					else row = { value: String(binds[1]), updated_at: "2026-08-06 00:00:00", updated_by: String(binds[2]) };
					return null;
				};
				return {
					bind: (...binds: unknown[]) => ({
						first: async () => exec(binds),
						run: async () => {
							exec(binds);
							return {};
						},
					}),
				};
			},
		},
	} as unknown as Env;
	return { env, writes, current: () => row };
}

describe("readPlatformAiSetting", () => {
	it("falls back to the deployed env var when no override is stored", async () => {
		const on = await readPlatformAiSetting(makeEnv(true).env);
		expect(on).toMatchObject({ enabled: true, source: "env", envDefault: true, override: null });
		const off = await readPlatformAiSetting(makeEnv(false).env);
		expect(off).toMatchObject({ enabled: false, source: "env", override: null });
	});

	it("lets a stored override BEAT the env var in both directions", async () => {
		// The whole point of the ticket: killing spend without a deploy, and — just as
		// important — turning it back on without one.
		const off = await readPlatformAiSetting(makeEnv(true, { row: { value: "false" } }).env);
		expect(off).toMatchObject({ enabled: false, source: "override", envDefault: true, override: false });
		const on = await readPlatformAiSetting(makeEnv(false, { row: { value: "true" } }).env);
		expect(on).toMatchObject({ enabled: true, source: "override", envDefault: false, override: true });
	});

	it("treats a junk stored value as NO override rather than as false", async () => {
		// Prevents a corrupt or half-written row from silently taking RAG dark platform-wide
		// — a value that isn't exactly "true"/"false" is not an operator decision.
		const s = await readPlatformAiSetting(makeEnv(true, { row: { value: "maybe" } }).env);
		expect(s).toMatchObject({ enabled: true, source: "env", override: null });
	});

	it("falls back to the env default when D1 errors", async () => {
		// Prevents a D1 blip from silently changing platform behaviour. Matches the
		// deliberate fail-open in requireUser's suspension lookup: the deployed
		// configuration stands. The honest consequence — an override of OFF does not
		// survive a D1 outage — is why PLATFORM_AI_ENABLED remains the hard backstop.
		expect(await platformAiEnabled(makeEnv(true, { throws: true }).env)).toBe(true);
		expect(await platformAiEnabled(makeEnv(false, { throws: true }).env)).toBe(false);
	});

	it("survives the table not existing yet (migration not applied)", async () => {
		const { env } = makeEnv(true, { throws: true });
		expect(await readPlatformAiSetting(env)).toMatchObject({ enabled: true, source: "env" });
	});
});

describe("platformAiBinding", () => {
	it("returns the binding when on and null when killed", async () => {
		// The call sites already handle a null AI as "indexing off", so the switch reuses
		// that shape instead of adding a second flag they could disagree with.
		expect(await platformAiBinding(makeEnv(true).env)).not.toBeNull();
		expect(await platformAiBinding(makeEnv(true, { row: { value: "false" } }).env)).toBeNull();
	});

	it("returns null when there is no AI binding at all", async () => {
		const { env } = makeEnv(true);
		(env as { AI?: unknown }).AI = undefined;
		expect(await platformAiBinding(env)).toBeNull();
	});
});

describe("setPlatformAiOverride", () => {
	it("writes the override and reports the new state immediately", async () => {
		// Immediacy is the requirement: no TTL anywhere, so the very next read — which is
		// what the next AI call performs — sees the flip.
		const { env, writes } = makeEnv(true);
		const after = await setPlatformAiOverride(env, false, "admin-1");
		expect(after).toMatchObject({ enabled: false, source: "override", override: false });
		expect(writes[0].binds).toEqual([PLATFORM_AI_KEY, "false", "admin-1"]);
		expect(await platformAiEnabled(env)).toBe(false);
	});

	it("clears the override with null, handing control back to the deployed default", async () => {
		// Prevents an override pinned forever, silently contradicting a later deploy that
		// changes the default.
		const { env, writes } = makeEnv(true, { row: { value: "false" } });
		const after = await setPlatformAiOverride(env, null, "admin-1");
		expect(writes[0].sql).toContain("DELETE");
		expect(after).toMatchObject({ enabled: true, source: "env", override: null });
	});

	it("records who flipped it", async () => {
		const { env } = makeEnv(true);
		const after = await setPlatformAiOverride(env, false, "admin-9");
		expect(after.updatedBy).toBe("admin-9");
	});
});
