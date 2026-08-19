import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_FRESH_MS } from "../lib/runtime-attachment.js";
import { ORPHANABLE_TASK_TYPES } from "../lib/runtime-task-ownership.js";
import {
	CLEARED_RUNTIME_TASK_STATUSES,
	callRuntime,
	expireOrphanedRuntimeTasks,
	runtimeNodeResponse,
	type RuntimeRow,
} from "./instances-runtime.js";
import type { Env } from "../types.js";
import type { TaskStatus } from "../../../../packages/browser-runner/src/types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/** Minimal env.DB stub: SELECT returns `rows`, INSERT/UPDATE writes are recorded. */
function mockEnv(rows: Array<{ id: string; payload: string }>): {
	env: Env;
	writes: Write[];
	selects: Write[];
} {
	const writes: Write[] = [];
	const selects: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							selects.push({ sql, args });
							// Deliberately NOT filtered by the SQL: the stub hands back every row so the
							// per-row guard is exercised on its own. The SQL half is asserted separately
							// against `selects` — those two predicates drifting apart is the original bug.
							return { results: rows };
						},
						async run() {
							writes.push({ sql, args });
							return {};
						},
						async first() {
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes, selects };
}

/** Minimal RuntimeRow for callRuntime tests. */
function mockRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
	return {
		instance_id: "inst-1",
		user_id: "user-1",
		placement: "local",
		endpoint_url: "https://tunnel.example.com",
		token_ciphertext: null,
		token_dek_wrapped: null,
		token_iv: null,
		token_plaintext: "tok",
		capabilities: "[]",
		runner_version: "",
		runner_node: "",
		status: "online",
		last_seen_at: null,
		created_at: "",
		updated_at: "",
		...overrides,
	};
}

/** Build a mock RELAY DO namespace. */
function mockRelay(handler: (req: Request) => Promise<Response>) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (_id: unknown) => ({ fetch: handler }),
	};
}

describe("the clear-finished filter names only statuses the column can hold (#611)", () => {
	/**
	 * The whole fix, as a type.
	 *
	 * `CLEARED_RUNTIME_TASK_STATUSES` carried `expired` for six months. Nothing writes it:
	 * `mirrorRuntimeTask` passes the runner's `TaskStatus` through, and both
	 * `expireOrphanedRuntimeTasks` and the runner's `expireInFlightTasks` write `failed` in spite of
	 * their names. So one quarter of a live `WHERE … IN` filter could never match a row, and no test
	 * could see it — an unmatchable member behaves exactly like a matchable one that happens to find
	 * nothing.
	 *
	 * This assignment is the guard, and it is a COMPILE error rather than a runtime one on purpose.
	 * A `TaskStatus` union has no runtime representation to iterate, so the alternative was parsing
	 * the runner's source with a regex (which `workers/mcp/src/state-vocabulary.test.ts` does, for
	 * the separate reason that it is a different deployable and cannot import across). Here the
	 * import is real, so the compiler can answer directly. Restoring `"expired"` to the array fails
	 * `tsc -p tsconfig.test.json` — the gate #599 added precisely so a type-level assertion in a
	 * worker test compiles somewhere and can actually go red.
	 */
	const _everyClearedStatusIsAReachableTaskStatus: readonly TaskStatus[] = CLEARED_RUNTIME_TASK_STATUSES;

	it("sweeps the three terminal statuses, and not `blocked` — which means waiting on the user", () => {
		expect([...CLEARED_RUNTIME_TASK_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
		// `blocked` is a TaskStatus and is deliberately NOT swept: it is an ACTIVE card awaiting the
		// human, and clearing the board must not hide the thing the board exists to surface.
		expect([...CLEARED_RUNTIME_TASK_STATUSES]).not.toContain("blocked");
	});

	it("names nothing a production row has never held", () => {
		// A full census of instance_runtime_tasks on 2026-08-16 (404 rows) returned exactly these
		// seven statuses and no `expired`, which is what settled #611 AC1. Kept as the record of the
		// measurement, so the next reader does not have to re-run it to know it was run.
		const observedInProduction = ["completed", "failed", "cancelled", "running", "needs_human", "blocked", "queued"];
		for (const status of CLEARED_RUNTIME_TASK_STATUSES) {
			expect(observedInProduction, `\`${status}\` is swept but no row has ever carried it`).toContain(status);
		}
	});
});

describe("expireOrphanedRuntimeTasks", () => {
	it("marks a task the dead runner process was running failed, with an orphan reason", async () => {
		const rows = [
			{ id: "t1", payload: JSON.stringify({ id: "t1", type: "browser.open", status: "needs_human" }) },
			{ id: "t2", payload: JSON.stringify({ id: "t2", type: "echo", status: "running" }) },
		];
		const { env, writes } = mockEnv(rows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(2);
		// mirrorRuntimeTask binds (id, instanceId, userId, type, status, payload, ...)
		expect(writes.map((w) => w.args[4])).toEqual(["failed", "failed"]);
		expect(String(writes[0].args[5])).toContain("orphaned");
	});

	it("does NOT expire workflow-driven job.apply_agent tasks (they survive a runner reconnect)", async () => {
		const rows = [
			{ id: "a1", payload: JSON.stringify({ id: "a1", type: "job.apply_agent", status: "needs_human" }) },
			{ id: "b2", payload: JSON.stringify({ id: "b2", type: "browser.open", status: "running" }) },
		];
		const { env, writes } = mockEnv(rows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(1); // only the browser.open task, NOT the apply task
		expect(writes.map((w) => String(w.args[0]))).toEqual(["b2"]);
	});

	it("does nothing when there are no in-flight tasks", async () => {
		const { env, writes } = mockEnv([]);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(0);
		expect(writes.length).toBe(0);
	});
});

/**
 * #567, from production. A runner reconnect failed a coding session that then ran for two more
 * hours and made 15 irreversible pushes to `origin main`, and failed a standing-policy card whose
 * policy deliberately has no actuator — both told "its browser session is gone. Re-run it to try
 * again." Neither was a browser session, and neither could be re-run.
 *
 * Both directions are asserted in one place, because the sweep's two halves have been fixed
 * against each other three times: a dead browser task IS still expired, and everything the cloud
 * owns is NOT.
 */
describe("a runner reconnect ends only what the dead runner process was running (#567)", () => {
	/** Every board card in this list is one a real reconnect fed to the old predicate. */
	const cloudOwnedRows = [
		// The live coding session from the report — `running`, and still working.
		{ id: "csess-1", payload: JSON.stringify({ id: "csess-1", type: "coding.session", status: "running" }) },
		// #553's contribution: a Pilot parked in a handoff. `needs_human` is the FIRST status in the
		// sweep's SELECT, so the column #553 built was inside the blast radius from the day it landed.
		{ id: "csess-2", payload: JSON.stringify({ id: "csess-2", type: "coding.session", status: "needs_human" }) },
		// The standing-policy card. `repo.tree_clean`'s actuator is null by decision.
		{ id: "repo-dirty-1", payload: JSON.stringify({ id: "repo-dirty-1", type: "coding.uncommitted", status: "needs_human" }) },
		{ id: "repo-branch-1", payload: JSON.stringify({ id: "repo-branch-1", type: "coding.off_branch", status: "needs_human" }) },
		{ id: "deleg-1", payload: JSON.stringify({ id: "deleg-1", type: "delegation", status: "running" }) },
		{ id: "esc-1", payload: JSON.stringify({ id: "esc-1", type: "escalation", status: "needs_human" }) },
		{ id: "pipe-1", payload: JSON.stringify({ id: "pipe-1", type: "pipeline.run", status: "running" }) },
		{ id: "tick-1", payload: JSON.stringify({ id: "tick-1", type: "ticket", status: "running" }) },
		{ id: "authz-1", payload: JSON.stringify({ id: "authz-1", type: "coding.unauthorized_act", status: "needs_human" }) },
		// The fourth drift: the runner keeps this across its own restart, the API's denylist never
		// named it, so `pags up` failed a live engine sign-in takeover from the cloud side.
		{ id: "handoff-1", payload: JSON.stringify({ id: "handoff-1", type: "browser.handoff", status: "needs_human" }) },
		{ id: "signin-1", payload: JSON.stringify({ id: "signin-1", type: "engine.signin", status: "needs_human" }) },
	];

	it("leaves every cloud-owned card untouched", async () => {
		const { env, writes } = mockEnv(cloudOwnedRows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		// The denominator: eleven cards went in, and the assertion is about all eleven — not about
		// finding one survivor.
		expect(cloudOwnedRows.length).toBe(11);
		expect(writes.map((w) => String(w.args[0]))).toEqual([]);
		expect(n).toBe(0);
	});

	it("still expires the browser takeover the sweep was built for, in the same pass", async () => {
		const dead = { id: "b-1", payload: JSON.stringify({ id: "b-1", type: "browser.open", status: "needs_human" }) };
		const { env, writes } = mockEnv([...cloudOwnedRows, dead]);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(1);
		expect(writes.map((w) => String(w.args[0]))).toEqual(["b-1"]);
		expect(JSON.parse(String(writes[0].args[5])).error).toContain("browser session is gone");
	});

	it("does not stamp completedAt on a task it never observed completing", async () => {
		const { env, writes } = mockEnv([
			{ id: "b-1", payload: JSON.stringify({ id: "b-1", type: "browser.open", status: "needs_human", createdAt: "2026-08-11T01:29:42Z" }) },
		]);
		await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		const payload = JSON.parse(String(writes[0].args[5]));
		// The card in the report read `completedAt: 01:31:00` while the work ran until 03:31:35.
		// The sweep knows when it gave up looking; it does not know when the work stopped.
		expect(payload).not.toHaveProperty("completedAt");
		expect(payload.status).toBe("failed");
		expect(payload.updatedAt).toBeTruthy();
	});

	it("filters in SQL by the same allowlist, so the two predicates cannot drift apart", async () => {
		const { env, selects } = mockEnv([]);
		await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(selects.length).toBe(1);
		// An allowlist (`IN`), never an exception list (`NOT IN`) — that direction is the bug.
		expect(selects[0].sql).toContain("type IN (");
		expect(selects[0].sql).not.toContain("NOT IN");
		expect(selects[0].args.slice(2)).toEqual([...ORPHANABLE_TASK_TYPES]);
	});
});

describe("callRuntime (relay-only)", () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it("sends GET requests with correct method", async () => {
		let relayPayload: { method: string; path: string; body: unknown } | null = null;
		const relay = mockRelay(async (req) => {
			relayPayload = await req.json() as typeof relayPayload;
			return Response.json({ ok: true });
		});
		const env = { RELAY: relay } as unknown as Env;
		const row = mockRow();

		const res = await callRuntime(env, row, "/health");
		expect(res.status).toBe(200);
		expect(relayPayload!.method).toBe("GET");
		expect(relayPayload!.path).toBe("/health");
	});

	it("sends POST requests and forwards body", async () => {
		let relayPayload: { method: string; path: string; body: unknown } | null = null;
		const relay = mockRelay(async (req) => {
			relayPayload = await req.json() as typeof relayPayload;
			return Response.json({ task: "created" });
		});
		const env = { RELAY: relay } as unknown as Env;
		const row = mockRow();

		const body = JSON.stringify({ type: "echo", input: {} });
		const res = await callRuntime(env, row, "/tasks", { method: "POST", body });
		expect(res.status).toBe(200);
		expect(relayPayload!.method).toBe("POST");
		expect(relayPayload!.body).toEqual({ type: "echo", input: {} });
	});

	it("throws when RELAY binding is absent", async () => {
		const env = {} as unknown as Env;
		const row = mockRow();
		await expect(callRuntime(env, row, "/health")).rejects.toThrow("RELAY binding not configured");
	});
});

/**
 * #570, from production. `instance_runtime_status` on one instance returned four node rows, three
 * of them last seen 2–4 days earlier, and all four said `online`. An operator asking "which of my
 * machines is up?" got four yeses and one right answer.
 */
describe("a node's reported status comes from its heartbeat, not from a write-once column (#570)", () => {
	const NOW = Date.parse("2026-08-15T00:00:00Z");
	const stamp = (msAgo: number) => new Date(NOW - msAgo).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
	// The clock is moved, not injected. An optional `now` PARAMETER is what shipped the bug this
	// suite now guards: both routes call `nodes.map(runtimeNodeResponse)`, so a second parameter
	// gets the array INDEX, and every test that passed one stayed green over a dead fix.
	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
	afterEach(() => { vi.useRealTimers(); });

	/** The observed table: one machine heartbeating, three registered days ago. All stored `online`. */
	const rows: RuntimeRow[] = [
		mockRow({ runner_node: "RLs-MacBook-Air", status: "online", last_seen_at: stamp(20_000) }),
		mockRow({ runner_node: "Sergeys-Mac-mini.local", status: "online", last_seen_at: stamp(3 * 86_400_000) }),
		mockRow({ runner_node: "RLs-MacBook-Air.local", status: "online", last_seen_at: stamp(4 * 86_400_000) }),
		mockRow({ runner_node: "Mac", status: "online", last_seen_at: stamp(5 * 86_400_000) }),
	];

	it("distinguishes the machine that is talking to us from the three that are not", () => {
		const serialised = rows.map((row) => runtimeNodeResponse(row));
		// The denominator: four rows in, four rows out, and the assertion names the status of every
		// one of them — not just that "at least one" is offline.
		expect(serialised.map((n) => [n.runnerNode, n.status])).toEqual([
			["RLs-MacBook-Air", "online"],
			["Sergeys-Mac-mini.local", "offline"],
			["RLs-MacBook-Air.local", "offline"],
			["Mac", "offline"],
		]);
		expect(serialised.filter((n) => n.status === "online")).toHaveLength(1);
	});

	// The shape BOTH routes actually use — `nodes.map(runtimeNodeResponse)`. This is not a stylistic
	// preference: `map` passes `(element, index, array)`, so the first version of this fix took the
	// index as its `now` and read `0 - <timestamp> < 90_000` — true for every row. It shipped, every
	// unit test here passed (each one supplied `now` itself), and production went on reporting four
	// machines online. A guard that calls the function more conveniently than its callers do is
	// measuring something nobody runs.
	it("is correct when called the way its callers call it, with map's index in the second slot", () => {
		const viaMap = rows.map(runtimeNodeResponse);
		expect(viaMap.map((n) => n.status)).toEqual(["online", "offline", "offline", "offline"]);
		// And directly, so the two paths are pinned to the same answer.
		expect(rows.map((row) => runtimeNodeResponse(row).status)).toEqual(viaMap.map((n) => n.status));
	});

	it("keeps every node listed, so a pin onto a machine that is switched off still resolves", () => {
		const serialised = rows.map((row) => runtimeNodeResponse(row));
		expect(serialised).toHaveLength(rows.length);
		// The pin target and its relay name survive — #570's stated regression risk is that fixing
		// the status field must not delete a machine from the "Runs on" tiles.
		expect(serialised.map((n) => n.relayName)).toEqual(
			rows.map((r) => `${r.instance_id}:node:${r.runner_node}`),
		);
		expect(serialised.every((n) => Boolean(n.lastSeenAt))).toBe(true);
	});

	it("uses the same window the status probe uses, on both sides of it", () => {
		const justInside = mockRow({ status: "online", last_seen_at: stamp(HEARTBEAT_FRESH_MS - 1_000) });
		const justOutside = mockRow({ status: "online", last_seen_at: stamp(HEARTBEAT_FRESH_MS + 1_000) });
		expect(runtimeNodeResponse(justInside).status).toBe("online");
		expect(runtimeNodeResponse(justOutside).status).toBe("offline");
	});

	it("never reports online for a row that has never been heard from", () => {
		expect(runtimeNodeResponse(mockRow({ status: "online", last_seen_at: null })).status).toBe("offline");
		expect(runtimeNodeResponse(mockRow({ status: "online", last_seen_at: "not a date" })).status).toBe("offline");
	});

	it("does not overrule a stored offline with a fresh-looking stamp", () => {
		// The derivation may only ever move the answer toward `offline`, so a future writer that
		// marks a node down is not undone by this function.
		expect(runtimeNodeResponse(mockRow({ status: "offline", last_seen_at: stamp(1_000) })).status).toBe("offline");
	});

	// The premise #570's fix rested on, measured rather than asserted from memory: the per-node
	// UPDATE in `updateRuntimeStatus` only runs when a caller passes a node, and at the time only
	// ONE caller did — so `"online"` was the only value the per-node column could ever hold.
	//
	// #587 changed that, deliberately: the two probe call sites now pass the node they actually
	// probed, so `instance_runtime_nodes.status` finally has an `offline` writer and the shared
	// `instance_runtimes` row can no longer be refreshed by a machine it does not name. The
	// assertion below therefore checks the property that matters — every node-passing call site
	// names its node rather than defaulting to the shared row — instead of the count, which was
	// only ever evidence for it.
	//
	// #598 closed the other half: EVERY call site now names its node, so the assertion below is
	// no longer "at least three of eight" but "all of them". Five of the eight — the three in the
	// `/tasks` revalidate and the two in `/task-events` — passed nothing, so they could refresh
	// the shared `instance_runtimes` row but could not mark a specific machine down, which is the
	// same asymmetry stated the other way round. (#598's body says four; the fifth is the
	// `.catch(() => undefined)` sibling inside the same `try`.) Each of them holds the row
	// `callRuntime` dispatched on, and `callRuntime` targets
	// `relayNameForInstance(row.instance_id, row.runner_node)` — so the node was always in hand.
	it("every node-passing call site writes a value the per-node column can hold", () => {
		const dir = join(__dirname, "..");
		const files: string[] = [];
		const walk = (d: string) => {
			for (const entry of readdirSync(d)) {
				const p = join(d, entry);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
			}
		};
		walk(dir);
		const calls: string[] = [];
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/updateRuntimeStatus\(\s*([^;]*?)\);/g)) {
				const args = m[1].replace(/\s+/g, " ").trim();
				// The declaration itself matches too; its parameters carry type annotations, calls don't.
				if (/\w+\??:\s*(Env|string)\b/.test(args)) continue;
				calls.push(args);
			}
		}
		// Eight call sites; the denominator is asserted so a shrinking scan cannot pass by finding
		// nothing.
		expect(calls.length).toBeGreaterThanOrEqual(8);
		const withNode = calls.filter((c) => c.split(",").length > 4);
		// ALL of them (#598). A node-less write can refresh the shared `instance_runtimes` row but
		// cannot mark a node down, so it is a writer that cannot express one of the transitions it
		// is responsible for — the shape of #570 and #587. Every caller already holds the row it
		// dispatched on, so there is no call site where the node is genuinely unknown; if one ever
		// appears, this failure is the place to record WHY an instance-level write is right there.
		const nodeless = calls.filter((c) => !withNode.includes(c));
		expect(nodeless, `these cannot mark a node down:\n${nodeless.join("\n")}`).toEqual([]);
		expect(withNode.length).toBe(calls.length);
		// Both declared values of the per-node column are now written by application code. Before
		// #587 only `"online"` was, which is what made the column a write-once field the serialiser
		// had no business publishing.
		expect(withNode.some((c) => c.includes('"online"'))).toBe(true);
		expect(withNode.some((c) => c.includes('"offline"'))).toBe(true);
	});
});
