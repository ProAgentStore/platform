/**
 * The default runtime row is serialised with the SAME heartbeat derivation the per-node row gets
 * (#587), and the shared row can no longer be a blend of two machines.
 *
 * #570 put the derivation in `runtimeNodeResponse` and left `runtimeResponse` publishing
 * `row.status` raw. The two functions sit ten lines apart and appear in the SAME response object
 * (`{ runtime, nodes }`, `routes/instances.ts:433`), so the bug was not "a stale field somewhere" —
 * it was one response contradicting itself, with the correct half printed next to the wrong one.
 *
 * The fixtures below are the two instances measured live on 2026-08-15, not invented shapes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { d1Timestamp, runtimeNodeResponse, runtimeResponse } from "./runtime-response.js";
import { HEARTBEAT_FRESH_MS } from "./runtime-attachment.js";
import type { RuntimeRow } from "./runtime-nodes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 7, 15, 10, 12, 0);

/** D1 writes `datetime('now')` as `YYYY-MM-DD HH:MM:SS`, no zone. Reproduce that exactly. */
const stamp = (agoMs: number) => new Date(NOW - agoMs).toISOString().replace("T", " ").slice(0, 19);

const row = (over: Partial<RuntimeRow> = {}): RuntimeRow =>
	({
		instance_id: "12ebf1f0",
		user_id: "u1",
		placement: "local",
		endpoint_url: "http://127.0.0.1:8787",
		capabilities: '["coding.repo-write"]',
		runner_version: "0.4.51",
		runner_node: "RLs-MacBook-Air.local",
		status: "online",
		last_seen_at: stamp(0),
		created_at: "2026-08-01 00:00:00",
		updated_at: stamp(0),
		token_plaintext: null,
		token_ciphertext: null,
		...over,
	}) as RuntimeRow;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("runtimeResponse derives status from the heartbeat (#587)", () => {
	it("reports the measured 10h36m-stale machine as offline, not online", () => {
		// `12ebf1f0` (Coder Home) and `6d2d9401` (Facebook Friends), read live 2026-08-15: the
		// shared row said `online` for RLs-MacBook-Air.local while that machine's own node row said
		// `offline`, last seen 2026-08-14 23:36:04. Ten hours and thirty-six minutes.
		const stale = row({ last_seen_at: "2026-08-14 23:36:04" });
		expect(runtimeResponse(stale).status).toBe("offline");
		// The field the user actually reads to decide whether to run `pags up` still names the
		// machine the row is about — it is the LIVENESS that was wrong, not the identity.
		expect(runtimeResponse(stale).runnerNode).toBe("RLs-MacBook-Air.local");
	});

	it("agrees with runtimeNodeResponse on the same row, which is the whole defect", () => {
		// Both halves of `{ runtime, nodes }` are built from rows of the same shape by functions
		// ten lines apart. When they disagreed, the response contradicted itself.
		for (const ms of [0, HEARTBEAT_FRESH_MS - 1_000, HEARTBEAT_FRESH_MS + 1_000, 10 * 3_600_000]) {
			const r = row({ last_seen_at: stamp(ms) });
			expect(runtimeResponse(r).status).toBe(runtimeNodeResponse(r).status);
		}
	});

	it("uses the same 90s window on both sides of it", () => {
		expect(runtimeResponse(row({ last_seen_at: stamp(HEARTBEAT_FRESH_MS - 1_000) })).status).toBe("online");
		expect(runtimeResponse(row({ last_seen_at: stamp(HEARTBEAT_FRESH_MS + 1_000) })).status).toBe("offline");
	});

	it("never reports online for a row that has never been heard from", () => {
		expect(runtimeResponse(row({ last_seen_at: null })).status).toBe("offline");
		expect(runtimeResponse(row({ last_seen_at: "not a date" })).status).toBe("offline");
	});

	it("can only move the answer toward offline — a stored offline survives a fresh stamp", () => {
		expect(runtimeResponse(row({ status: "offline", last_seen_at: stamp(1_000) })).status).toBe("offline");
	});

	it("still publishes `registered` for a fresh registration that has not yet heartbeat", () => {
		// `registered` is the DEFAULT and a real state: the row exists, the runner has just said
		// hello. Collapsing it to `offline` would lose the distinction the register route returns.
		expect(runtimeResponse(row({ status: "registered", last_seen_at: stamp(1_000) })).status).toBe("registered");
	});

	it("does not leak the token, before or after the derivation", () => {
		expect(runtimeResponse(row({ token_plaintext: "secret" })).hasToken).toBe(true);
		expect(JSON.stringify(runtimeResponse(row({ token_plaintext: "secret" })))).not.toContain("secret");
	});
});

describe("a synthesised timestamp is written in the shape the derivation parses (#587)", () => {
	// FOUND IN PRODUCTION, not here — the regression this file's own fix introduced, caught by
	// checking the deployed API rather than by a green suite.
	//
	// `/runtime/status` echoes the row it just wrote, and built it with `new Date().toISOString()`.
	// `heartbeatFresh` parses a stored stamp as `` `${s.replace(" ", "T")}Z` ``, so an ISO string —
	// which already ends in `Z` — becomes `…ZZ`, `Date.parse` returns NaN, and the row reads as
	// never-heard-from. Harmless while the status was published raw; the moment the status was
	// DERIVED from that stamp, the probe began reporting `offline` for a machine it had just
	// successfully reached. Every fixture in this file was already written in the D1 shape, which
	// is exactly why the suite could not see it.
	it("d1Timestamp is fresh; toISOString is not", () => {
		expect(runtimeResponse(row({ status: "online", last_seen_at: d1Timestamp() })).status).toBe("online");
		expect(runtimeResponse(row({ status: "online", last_seen_at: new Date().toISOString() })).status).toBe("offline");
	});

	it("d1Timestamp emits exactly the shape D1's datetime('now') does", () => {
		expect(d1Timestamp(new Date(NOW))).toBe("2026-08-15 10:12:00");
		expect(d1Timestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("no route hands runtimeResponse an ISO timestamp", () => {
		// The invariant, not just the instance: a `last_seen_at` built at a call site must go
		// through `d1Timestamp`. Checked over the source because the next such call site will be
		// written by someone who has not read the paragraph above.
		const dir = join(__dirname, "..");
		const offenders: string[] = [];
		const walk = (d: string) => {
			for (const entry of readdirSync(d)) {
				const p = join(d, entry);
				if (statSync(p).isDirectory()) {
					walk(p);
					continue;
				}
				if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
				const src = readFileSync(p, "utf8");
				for (const m of src.matchAll(/last_seen_at:\s*([^,\n}]+)/g)) {
					if (m[1].includes("toISOString")) offenders.push(`${p.slice(dir.length + 1)}: ${m[1].trim()}`);
				}
			}
		};
		walk(dir);
		expect(offenders, `use d1Timestamp() — an ISO string parses to NaN in heartbeatFresh:\n${offenders.join("\n")}`).toEqual([]);
	});
});

describe("runtimeNodeResponse is runtimeResponse plus the relay name", () => {
	it("adds relayName and changes nothing else", () => {
		const r = row({ runner_node: "laptop-A" });
		const { relayName, ...rest } = runtimeNodeResponse(r);
		expect(relayName).toBe("12ebf1f0:node:laptop-A");
		expect(rest).toEqual(runtimeResponse(r));
	});

	it("survives being passed straight to Array.prototype.map", () => {
		// The #570 regression: `map` supplies `(element, index, array)`, so any second parameter
		// this function grows is filled with 0, 1, 2… Assert against the real call shape.
		const rows = [row({ last_seen_at: stamp(0) }), row({ last_seen_at: stamp(10 * 3_600_000) })];
		expect(rows.map(runtimeNodeResponse).map((n) => n.status)).toEqual(["online", "offline"]);
	});
});
