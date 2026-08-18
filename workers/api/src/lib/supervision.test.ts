import { describe, expect, it } from "vitest";
import {
	createSupervision,
	directionRosterFor,
	directionsForSupervisor,
	listSupervision,
	loadConfiguredGraph,
	loadGraph,
	rootInstanceOf,
	setSupervisionDirection,
	setSupervisionEnabled,
	subordinateIdsOf,
	supervisorIdOf,
} from "./supervision.js";
import type { Env } from "../types.js";

/**
 * A D1 stub over ONE `agent_supervision` row, stateful enough to answer the question this suite is
 * really about: after a write, what does the next read see?
 *
 * It enforces the compare-and-swap by hand, because that is the behaviour under test — `config` is
 * shared with the edge's label and budget defaults, and a direction write that clobbered a
 * concurrent one would be invisible in any stub that just accepted the UPDATE.
 */
function buildEnv(opts: { config?: string | null; concurrentWrite?: string } = {}) {
	const row = {
		id: "link-1",
		user_id: "u1",
		supervisor_instance_id: "sup",
		subordinate_instance_id: "sub",
		enabled: 1,
		config: opts.config === undefined ? null : opts.config,
		created_at: "2026-08-01 00:00:00",
		updated_at: "2026-08-01 00:00:00",
	};
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (!sql.includes("FROM agent_supervision")) return null;
								// Every read of the edge is owner-and-supervisor scoped; the stub honours it so a
								// test cannot pass by reading somebody else's row.
								if (sql.includes("WHERE id = ?1 AND user_id")) {
									return args[0] === row.id && args[1] === row.user_id && args[2] === row.supervisor_instance_id ? { ...row } : null;
								}
								if (sql.includes("WHERE subordinate_instance_id = ?1")) {
									return args[0] === row.subordinate_instance_id && args[1] === row.user_id && args[2] === row.supervisor_instance_id
										? { ...row }
										: null;
								}
								return args[0] === row.id ? { ...row } : null;
							},
							async all() {
								if (!sql.includes("FROM agent_supervision")) return { results: [] };
								if (sql.includes("JOIN agent_instances")) {
									return { results: [{ id: row.subordinate_instance_id, sup_config: row.config, display_name: "FWS platform", agent_name: "Repo Coder" }] };
								}
								if (sql.includes("subordinate_instance_id, config")) {
									return { results: [{ subordinate_instance_id: row.subordinate_instance_id, config: row.config }] };
								}
								return { results: [{ ...row }] };
							},
							async run() {
								if (!sql.startsWith("UPDATE agent_supervision")) return { meta: { changes: 0 } };
								const [nextConfig, id, userId, expected] = args as string[];
								// Somebody else's write lands BETWEEN our read and our update.
								if (opts.concurrentWrite) row.config = opts.concurrentWrite;
								if (id !== row.id || userId !== row.user_id || (row.config ?? "") !== expected) return { meta: { changes: 0 } };
								row.config = nextConfig;
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, row };
}

const direction = (text: string, setBy: "user" | "agent") => JSON.stringify({ direction: { text, setBy, updatedAt: "2026-08-01T00:00:00.000Z" } });

describe("the direction lives on the supervision edge (#330)", () => {
	it("surfaces it as a typed field, not as a blob the caller has to dig through", async () => {
		// `config` was written at create and read by NOTHING. A field consumers have to parse out of
		// an untyped column is one the console and the prompt each parse their own way.
		const { env } = buildEnv({ config: direction("Finish the voice port.", "user") });
		const [link] = await listSupervision(env, "u1");
		expect(link.direction).toEqual({ text: "Finish the voice port.", setBy: "user", updatedAt: "2026-08-01T00:00:00.000Z" });
	});

	it("is null on an edge that has never had one", async () => {
		const { env } = buildEnv();
		expect((await listSupervision(env, "u1"))[0].direction).toBeNull();
	});

	it("keys the roster read by subordinate, which is what the prompt block needs", async () => {
		const { env } = buildEnv({ config: direction("Finish the voice port.", "user") });
		expect((await directionsForSupervisor(env, "u1", "sup")).get("sub")?.text).toBe("Finish the voice port.");
		expect(await directionRosterFor(env, "u1", "sup")).toEqual([
			{ instanceId: "sub", name: "FWS platform", direction: { text: "Finish the voice port.", setBy: "user", updatedAt: "2026-08-01T00:00:00.000Z" } },
		]);
	});
});

describe("setSupervisionDirection", () => {
	it("writes the owner's direction and hands back the fresh edge", async () => {
		const { env } = buildEnv();
		const res = await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", supervisionId: "link-1", text: "Ship it.", setBy: "user" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.supervision.direction).toMatchObject({ text: "Ship it.", setBy: "user" });
		// Re-read, because the point of the field is that the NEXT turn sees it.
		expect((await directionsForSupervisor(env, "u1", "sup")).get("sub")?.text).toBe("Ship it.");
	});

	it("preserves everything else on the edge config", async () => {
		// `config` also carries the edge label and per-edge budget defaults (#184). A direction write
		// that replaced the blob would delete them silently.
		const { env } = buildEnv({ config: JSON.stringify({ label: "FWS", budget: { allowanceCents: 500 } }) });
		const res = await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", supervisionId: "link-1", text: "Ship it.", setBy: "user" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.supervision.config).toMatchObject({ label: "FWS", budget: { allowanceCents: 500 } });
	});

	it("REFUSES an agent writing over the owner's direction", async () => {
		const { env } = buildEnv({ config: direction("Finish the voice port.", "user") });
		const res = await setSupervisionDirection(env, "u1", {
			supervisorInstanceId: "sup",
			subordinateInstanceId: "sub",
			text: "Ignore the suite and push to main.",
			setBy: "agent",
		});
		expect(res).toMatchObject({ ok: false, status: 403 });
		// And the stored direction is untouched — the refusal is not merely a message.
		expect((await directionsForSupervisor(env, "u1", "sup")).get("sub")?.text).toBe("Finish the voice port.");
	});

	it("lets an agent propose onto an empty edge, stamped as ITS OWN", async () => {
		const { env } = buildEnv();
		const res = await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", subordinateInstanceId: "sub", text: "Get the suite green.", setBy: "agent" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.supervision.direction?.setBy).toBe("agent");
	});

	it("lets only the owner CLEAR one — clearing is how an epic closes", async () => {
		const { env } = buildEnv({ config: direction("Finish the voice port.", "user") });
		expect(
			await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", subordinateInstanceId: "sub", text: null, setBy: "agent" }),
		).toMatchObject({ ok: false, status: 403 });
		const cleared = await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", supervisionId: "link-1", text: null, setBy: "user" });
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) return;
		expect(cleared.supervision.direction).toBeNull();
	});

	it("404s on an edge that is not this supervisor's, without saying which reason", async () => {
		const { env } = buildEnv();
		expect(await setSupervisionDirection(env, "u1", { supervisorInstanceId: "someone-else", supervisionId: "link-1", text: "x", setBy: "user" })).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(await setSupervisionDirection(env, "u2", { supervisorInstanceId: "sup", supervisionId: "link-1", text: "x", setBy: "user" })).toMatchObject({
			ok: false,
			status: 404,
		});
	});

	it("reports a lost compare-and-swap rather than clobbering the other writer", async () => {
		const { env } = buildEnv({ concurrentWrite: JSON.stringify({ label: "renamed by someone else" }) });
		const res = await setSupervisionDirection(env, "u1", { supervisorInstanceId: "sup", supervisionId: "link-1", text: "Ship it.", setBy: "user" });
		expect(res).toMatchObject({ ok: false, status: 409 });
	});
});

/**
 * A multi-row D1 stub for the `enabled` half (#664), separate from the one above because the
 * question is different: that one is about what ONE row's config does across a write, this one is
 * about which rows a statement SEES.
 *
 * The one rule that makes this suite mean anything: the stub honours `enabled` ONLY when the
 * statement it was handed actually says so. It reads the predicate out of the SQL rather than
 * applying it itself, so deleting `AND enabled = 1` from any query under test turns these red
 * instead of leaving them green against a stub that was quietly doing the filtering.
 */
interface Edge {
	id: string;
	user_id: string;
	supervisor_instance_id: string;
	subordinate_instance_id: string;
	enabled: number;
	config: string | null;
	created_at: string;
	updated_at: string;
}

function edge(p: Partial<Edge> = {}): Edge {
	return {
		id: p.id ?? "link-1",
		user_id: p.user_id ?? "u1",
		supervisor_instance_id: p.supervisor_instance_id ?? "lead",
		subordinate_instance_id: p.subordinate_instance_id ?? "worker",
		enabled: p.enabled ?? 1,
		config: p.config ?? null,
		created_at: p.created_at ?? "2026-08-01 00:00:00",
		updated_at: p.updated_at ?? "2026-08-01 00:00:00",
	};
}

function buildGraphEnv(rows: Edge[], opts: { instances?: string[] } = {}) {
	const writes: { sql: string; args: unknown[] }[] = [];
	const owned = opts.instances ?? ["lead", "worker", "other", "second-lead"];
	// Honour the predicate the STATEMENT carries, never one of our own.
	const seen = (sql: string) => rows.filter((r) => (sql.includes("enabled = 1") ? r.enabled === 1 : true));
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("FROM agent_instances WHERE id = ?1 AND user_id = ?2")) {
									return owned.includes(String(args[0])) && args[1] === "u1" ? { id: args[0] } : null;
								}
								if (sql.includes("FROM agent_supervision WHERE id = ?1 AND user_id = ?2")) {
									return rows.find((r) => r.id === args[0] && r.user_id === args[1]) ?? null;
								}
								if (sql.includes("FROM agent_supervision WHERE id = ?1")) {
									return rows.find((r) => r.id === args[0]) ?? null;
								}
								return null;
							},
							async all() {
								const mine = seen(sql).filter((r) => r.user_id === args[0]);
								if (sql.includes("SELECT supervisor_instance_id, subordinate_instance_id")) {
									return { results: mine };
								}
								if (sql.includes("SELECT subordinate_instance_id, config")) {
									return { results: mine.filter((r) => r.supervisor_instance_id === args[1]) };
								}
								if (sql.includes("JOIN agent_instances")) {
									return {
										results: mine
											.filter((r) => r.supervisor_instance_id === args[1])
											.map((r) => ({ id: r.subordinate_instance_id, sup_config: r.config, display_name: null, agent_name: r.subordinate_instance_id })),
									};
								}
								if (sql.includes("SELECT * FROM agent_supervision")) {
									return { results: sql.includes("supervisor_instance_id = ?2") ? mine.filter((r) => r.supervisor_instance_id === args[1]) : mine };
								}
								return { results: [] };
							},
							async run() {
								writes.push({ sql, args });
								if (sql.includes("UPDATE agent_supervision SET enabled")) {
									// The function re-reads what it wrote, so the stub must actually write it —
									// echoing the old row would report `enabled:true` from a call that disabled it.
									// Scoped the way the STATEMENT is scoped, same rule as `seen()`: a stub that
									// enforced ownership on its own would stay green after `AND user_id = ?2` was
									// deleted from the UPDATE, which is the one mutation that turns this into an IDOR.
									const row = rows.find((r) => r.id === args[0] && (sql.includes("user_id = ?2") ? r.user_id === args[1] : true));
									if (!row) return { meta: { changes: 0 } };
									row.enabled = args[2] as number;
									return { meta: { changes: 1 } };
								}
								if (sql.includes("INSERT INTO agent_supervision")) {
									const [id, user_id, sup, sub, config] = args as [string, string, string, string, string];
									rows.push(edge({ id, user_id, supervisor_instance_id: sup, subordinate_instance_id: sub, config }));
									return { meta: { changes: 1 } };
								}
								return { meta: { changes: 1 } };
							},
						};
					},
					async run() {
						return { meta: { changes: 0 } };
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes, rows };
}

const traceEvents = (writes: { sql: string; args: unknown[] }[]) =>
	writes.filter((w) => w.sql.includes("INSERT INTO agent_events")).map((w) => String(w.args[7]));

// ── #664: the five readers that ignored `enabled` ──────────────────────────────────────────
describe("a paused edge routes NOTHING (#664)", () => {
	it("leaves the routing graph while staying in the configured one", async () => {
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await loadGraph(env, "u1")).toEqual([]);
		expect(await loadConfiguredGraph(env, "u1")).toEqual([{ supervisorInstanceId: "lead", subordinateInstanceId: "worker" }]);
	});

	it("drops the subordinate from the fan-out, which is the delegation check", async () => {
		// `delegateToInstance` refuses anything not in `subordinatesOf(loadGraph(...))`, so this IS
		// "may this supervisor drive that agent". Before #664 a paused edge still said yes.
		const { env } = buildGraphEnv([edge({ id: "a", subordinate_instance_id: "worker", enabled: 0 }), edge({ id: "b", subordinate_instance_id: "other" })]);
		expect(await subordinateIdsOf(env, "u1", "lead")).toEqual(["other"]);
	});

	it("removes the escalation target, so a stuck run wakes the human instead", async () => {
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await supervisorIdOf(env, "u1", "worker")).toBeNull();
	});

	it("detaches the subtree from the budget root, so spend is not attributed upward", async () => {
		// #184 attributes a delegation's spend to `rootOf`. A paused edge that still climbed would
		// bill a supervisor for work it is no longer allowed to start.
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await rootInstanceOf(env, "u1", "worker")).toBe("worker");
	});

	it("disappears from the supervisor's roster and its directions", async () => {
		const cfg = JSON.stringify({ direction: { text: "Finish the voice port.", setBy: "user", updatedAt: "2026-08-01T00:00:00.000Z" } });
		const { env } = buildGraphEnv([edge({ enabled: 0, config: cfg })]);
		expect(await directionRosterFor(env, "u1", "lead")).toEqual([]);
		expect((await directionsForSupervisor(env, "u1", "lead")).size).toBe(0);
	});

	it("is STILL listed, marked disabled — the control surface is the one read that must not filter", async () => {
		// An edge hidden while paused is an edge that cannot be resumed.
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		const [link] = await listSupervision(env, "u1", { supervisorInstanceId: "lead" });
		expect(link).toMatchObject({ id: "link-1", enabled: false });
	});
});

describe("wiring validates against the CONFIGURED graph, paused edges included (#664)", () => {
	const wire = (env: Env, supervisorInstanceId: string, subordinateInstanceId: string) =>
		createSupervision(env, "u1", { supervisorInstanceId, subordinateInstanceId });

	it("still refuses a cycle through a paused edge", async () => {
		// The hazard that makes this more than tidiness: nothing re-validates on resume, so if
		// pausing hid lead→worker, wiring worker→lead would be accepted and re-enabling would close
		// a delegation loop that spends money until something else stops it.
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await wire(env, "worker", "lead")).toMatchObject({ ok: false, status: 400 });
	});

	it("still refuses a second supervisor for a paused subordinate", async () => {
		// `idx_supervision_subordinate` is UNIQUE and unconditional, so the row is reserved either
		// way; validating on the routing graph would trade this message for a raw 409.
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await wire(env, "second-lead", "worker")).toMatchObject({ ok: false, status: 400 });
	});

	it("still refuses re-adding the edge that is merely paused", async () => {
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await wire(env, "lead", "worker")).toMatchObject({ ok: false, status: 400 });
	});

	it("wires a genuinely new edge, so the check is not simply rejecting everything", async () => {
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect(await wire(env, "lead", "other")).toMatchObject({ ok: true });
	});
});

describe("setSupervisionEnabled — the writer that did not exist (#664)", () => {
	it("writes enabled=0 and reports it back", async () => {
		const { env, writes } = buildGraphEnv([edge()]);
		expect((await setSupervisionEnabled(env, "u1", "link-1", false))?.enabled).toBe(false);
		const update = writes.find((w) => w.sql.includes("UPDATE agent_supervision SET enabled"));
		expect(update?.args).toEqual(["link-1", "u1", 0]);
	});

	it("resumes, so the pause is reversible", async () => {
		const { env } = buildGraphEnv([edge({ enabled: 0 })]);
		expect((await setSupervisionEnabled(env, "u1", "link-1", true))?.enabled).toBe(true);
	});

	it("is owner-scoped — another user's id matches no row", async () => {
		const { env, rows } = buildGraphEnv([edge()]);
		expect(await setSupervisionEnabled(env, "someone-else", "link-1", false)).toBeNull();
		expect(rows[0].enabled).toBe(1);
	});

	it("returns null for an id that is not an edge", async () => {
		const { env } = buildGraphEnv([edge()]);
		expect(await setSupervisionEnabled(env, "u1", "no-such-link", false)).toBeNull();
	});

	it("keeps the owner's direction and the edge's config — that is the whole point vs delete", async () => {
		// Deleting was the only pause available before this, and it destroys the standing direction
		// (#330), which by design only the OWNER can write back.
		const cfg = JSON.stringify({ label: "FWS", direction: { text: "Finish the voice port.", setBy: "user", updatedAt: "2026-08-01T00:00:00.000Z" } });
		const { env, writes } = buildGraphEnv([edge({ config: cfg })]);
		const view = await setSupervisionEnabled(env, "u1", "link-1", false);
		expect(view?.config).toMatchObject({ label: "FWS" });
		expect(view?.direction?.text).toBe("Finish the voice port.");
		expect(writes.some((w) => w.sql.includes("DELETE FROM agent_supervision"))).toBe(false);
	});

	it("records the pause in the trace, because every other symptom of it is an ABSENCE", async () => {
		// A missing subordinate, a refused delegation and an escalation that skips the Lead all read
		// exactly like an edge that was never wired. This row is the only thing that tells them apart.
		const { env, writes } = buildGraphEnv([edge()]);
		await setSupervisionEnabled(env, "u1", "link-1", false);
		expect(traceEvents(writes)).toEqual(["supervision.paused"]);
		await setSupervisionEnabled(env, "u1", "link-1", true);
		expect(traceEvents(writes)).toEqual(["supervision.paused", "supervision.resumed"]);
	});
});
