import { describe, expect, it, vi, afterEach } from "vitest";
import {
	callRunner,
	getBoundRunnerConn,
	getRunnerConn,
	getRunnerConnForStampedNode,
	getRunnerConnIgnoringLiveness,
	isRunnerOnline,
	relayConnected,
	READ_TIMEOUT_MS,
	sameMachine,
	verifyRunnerResponsive,
	type RunnerConn,
} from "./runner-client.js";
import { normalizeRunnerNode, relayNameForInstance } from "./runtime-nodes.js";
import { isRunnerUnreachable, type RunnerUnreachableError } from "./runner-unreachable.js";
import type { Env } from "../types.js";

type MockRelay = {
	idFromName: (name: string) => { name: string };
	get: (id: { name: string }) => { fetch: (req: Request) => Promise<Response> };
};

/** Build a mock RELAY namespace. */
function mockRelay(handler: (req: Request) => Promise<Response>): MockRelay {
	return {
		idFromName: (name: string) => ({ name }),
		get: () => ({ fetch: handler }),
	};
}

function mockConn(overrides: Partial<RunnerConn & { RELAY?: MockRelay }> = {}): RunnerConn {
	return {
		endpointUrl: "http://127.0.0.1:49171",
		token: "runner-tok",
		instanceId: "inst-1",
		userId: "user-1",
		relayName: "inst-1",
		env: {
			RELAY: overrides.RELAY ?? undefined,
			DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
		} as unknown as Env,
		...overrides,
	};
}

describe("isRunnerOnline", () => {
	const envWith = (RELAY: unknown) => ({ RELAY }) as unknown as Env;

	it("true when the RelayDO reports a connected runner", async () => {
		const relay = mockRelay(async (req) => {
			expect(new URL(req.url).pathname).toBe("/status");
			return Response.json({ connected: true });
		});
		expect(await isRunnerOnline(envWith(relay), "inst-1")).toBe(true);
	});

	it("false when the RelayDO reports no runner", async () => {
		const relay = mockRelay(async () => Response.json({ connected: false }));
		expect(await isRunnerOnline(envWith(relay), "inst-1")).toBe(false);
	});

	it("false (never throws) with no RELAY binding or on a DO error", async () => {
		expect(await isRunnerOnline(envWith(undefined), "inst-1")).toBe(false);
		const boom = mockRelay(async () => { throw new Error("DO down"); });
		expect(await isRunnerOnline(envWith(boom), "inst-1")).toBe(false);
	});

	it("checks node-scoped relay status when a runner node is provided", async () => {
		let seenName = "";
		const relay = {
			idFromName: (name: string) => {
				seenName = name;
				return { name };
			},
			get: () => ({ fetch: async () => Response.json({ connected: true }) }),
		};
		expect(await relayConnected(envWith(relay), "inst-1", "macbook")).toBe(true);
		expect(seenName).toBe("inst-1:node:macbook");
	});
});

describe("verifyRunnerResponsive (#1401) — a VERIFIED check, distinct from relayConnected's optimistic one", () => {
	const envWith = (RELAY: unknown) => ({ RELAY }) as unknown as Env;

	it("asks /status?verify=1 — the waited-for probe, not the optimistic one relayConnected reads", async () => {
		let seenUrl = "";
		const relay = mockRelay(async (req) => {
			seenUrl = req.url;
			return Response.json({ connected: true });
		});
		expect(await verifyRunnerResponsive(envWith(relay), "inst-1")).toBe(true);
		expect(new URL(seenUrl).pathname).toBe("/status");
		expect(new URL(seenUrl).searchParams.get("verify")).toBe("1");
	});

	it("false when the relay's VERIFIED probe found nothing answering — the exact pink-laptop shape: a socket listed, but dead", async () => {
		const relay = mockRelay(async () => Response.json({ connected: false }));
		expect(await verifyRunnerResponsive(envWith(relay), "inst-1")).toBe(false);
	});

	it("false (never throws) with no RELAY binding or on a DO error", async () => {
		expect(await verifyRunnerResponsive(envWith(undefined), "inst-1")).toBe(false);
		const boom = mockRelay(async () => { throw new Error("DO down"); });
		expect(await verifyRunnerResponsive(envWith(boom), "inst-1")).toBe(false);
	});

	it("is node-scoped exactly like relayConnected", async () => {
		let seenName = "";
		const relay = {
			idFromName: (name: string) => { seenName = name; return { name }; },
			get: () => ({ fetch: async () => Response.json({ connected: true }) }),
		};
		expect(await verifyRunnerResponsive(envWith(relay), "inst-1", "macbook")).toBe(true);
		expect(seenName).toBe("inst-1:node:macbook");
	});
});

describe("callRunner (relay-only)", () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it("sends command through relay and returns result", async () => {
		const relay = mockRelay(async (req) => {
			const body = await req.json() as { method?: string; path?: string };
			expect(body.method).toBe("POST");
			expect(body.path).toBe("/browser/snapshot");
			return Response.json({ url: "https://job.com", snapshot: "<html>" });
		});
		const conn = mockConn({ RELAY: relay });
		const result = await callRunner<{ url: string }>(conn, "/browser/snapshot", { taskId: "t1" });
		expect(result.url).toBe("https://job.com");
	});

	it("uses the node-scoped relay name when a session is pinned to a runner node", async () => {
		let seenName = "";
		const relay = {
			idFromName: (name: string) => {
				seenName = name;
				return { name };
			},
			get: () => ({
				fetch: async () => Response.json({ ok: true }),
			}),
		};
		const conn = mockConn({ RELAY: relay, relayName: "inst-1:node:macbook" });
		await callRunner(conn, "/coding/capture", { sessionId: "s1" });
		expect(seenName).toBe("inst-1:node:macbook");
	});

	it("throws a TYPED, retryable error when relay returns 503 (no runner connected)", async () => {
		// #341: the caller must be able to tell "gone for now" from "broken" without reading the
		// wording, and the message must not prescribe `pags up` to someone already running it.
		const relay = mockRelay(async () => Response.json({ error: "No runner connected" }, { status: 503 }));
		const conn = mockConn({ RELAY: relay });
		const err = await callRunner(conn, "/test").then(() => null, (e) => e as Error);
		expect(isRunnerUnreachable(err)).toBe(true);
		expect(err?.message).toContain("No runner connected");
		expect(err?.message).not.toContain("run `pags up`");
	});

	it("preserves the clear nonresponsive-relay error from the bounded command liveness probe", async () => {
		const relay = mockRelay(async () => Response.json(
			{ error: "Runner relay is connected but not responding", code: "RUNNER_RELAY_UNRESPONSIVE" },
			{ status: 503 },
		));
		const err = await callRunner(mockConn({ RELAY: relay }), "/coding/start").then(() => null, (e) => e as Error);
		expect(isRunnerUnreachable(err)).toBe(true);
		expect(err?.message).toContain("connected but not responding");
	});

	it("treats a socket that dropped mid-command (504) as unreachable, but a hung runner as a real error", async () => {
		const dropped = mockRelay(async () => Response.json({ error: "Runner disconnected" }, { status: 504 }));
		expect(isRunnerUnreachable(await callRunner(mockConn({ RELAY: dropped }), "/test").catch((e) => e))).toBe(true);
		const hung = mockRelay(async () => Response.json({ error: "Relay command timed out" }, { status: 504 }));
		expect(isRunnerUnreachable(await callRunner(mockConn({ RELAY: hung }), "/test").catch((e) => e))).toBe(false);
	});

	it("only the RELAY's own 503 is 'no socket'; a runner's 503 is its own statement (#1344)", async () => {
		const noSocket = mockRelay(async () => Response.json({ error: "No runner connected", code: "RUNNER_RELAY_NO_SOCKET" }, { status: 503 }));
		const a = (await callRunner(mockConn({ RELAY: noSocket }), "/coding/act").catch((e) => e)) as RunnerUnreachableError;
		expect(isRunnerUnreachable(a)).toBe(true);
		expect(a.dispatched).toBe(false);
		// The runner refusing new work while it drains for an update: refused before it ran, so still not dispatched —
		// but a connected runner, said as such rather than "the relay has no live socket".
		const draining = mockRelay(async () => Response.json({ error: "Runner is draining for a safe automatic update; retry shortly." }, { status: 503 }));
		const d = (await callRunner(mockConn({ RELAY: draining }), "/coding/act").catch((e) => e)) as RunnerUnreachableError;
		expect(isRunnerUnreachable(d)).toBe(true);
		expect(d.dispatched).toBe(false);
		expect(d.message).toContain("draining for an automatic update");
		expect(d.message).not.toContain("no live socket");
		// Any other runner 503 is an ordinary failure — never a false "nothing was sent, safe to re-send".
		const other = mockRelay(async () => Response.json({ error: "Service Unavailable" }, { status: 503 }));
		expect(isRunnerUnreachable(await callRunner(mockConn({ RELAY: other }), "/coding/act").catch((e) => e))).toBe(false);
	});

	it("a READ the relay timed out is a silent runner the guard can wait out; a mutating command keeps the plain error (#1341)", async () => {
		const hung = mockRelay(async () => Response.json({ error: "Relay command timed out" }, { status: 504 }));
		const capture = (await callRunner(mockConn({ RELAY: hung }), "/coding/capture", { sessionId: "s1" }).catch((e) => e)) as Error;
		expect(isRunnerUnreachable(capture)).toBe(true);
		expect(isRunnerUnreachable(new Error(capture.message))).toBe(true); // across a step boundary
		expect(capture.message).toContain("/coding/capture → 504: Relay command timed out");
		// A command that may have run is never re-sent on a guess (#1015).
		const act = (await callRunner(mockConn({ RELAY: hung }), "/coding/act", { sessionId: "s1" }).catch((e) => e)) as Error;
		expect(isRunnerUnreachable(act)).toBe(false);
	});

	it("throws when RELAY binding is absent", async () => {
		const conn = mockConn({ RELAY: undefined });
		await expect(callRunner(conn, "/test")).rejects.toThrow("RELAY binding not configured");
	});

	it("propagates relay errors", async () => {
		const relay = mockRelay(async () => Response.json({ error: "Internal" }, { status: 500 }));
		const conn = mockConn({ RELAY: relay });
		await expect(callRunner(conn, "/test")).rejects.toThrow("Runner /test");
	});

	it("forwards a short read timeout so a hung runner can't wedge a capture poll", async () => {
		let seen: number | undefined = -1;
		const relay = mockRelay(async (req) => {
			seen = ((await req.json()) as { timeoutMs?: number }).timeoutMs;
			return Response.json({ pane: "…" });
		});
		const conn = mockConn({ RELAY: relay });
		await callRunner(conn, "/coding/capture", { sessionId: "s1" }, { timeoutMs: READ_TIMEOUT_MS });
		expect(seen).toBe(READ_TIMEOUT_MS);
	});

	it("omits timeoutMs by default (relay keeps its long default for mutating commands)", async () => {
		let seen: number | undefined = -1;
		const relay = mockRelay(async (req) => {
			seen = ((await req.json()) as { timeoutMs?: number }).timeoutMs;
			return Response.json({ ok: true });
		});
		const conn = mockConn({ RELAY: relay });
		await callRunner(conn, "/coding/act", { sessionId: "s1" });
		expect(seen).toBeUndefined();
	});

	it("gives a quick read its route's fail-fast timeout when the caller names none (#1358), and lets the caller override it", async () => {
		const seen: Array<number | undefined> = [];
		const relay = mockRelay(async (req) => {
			seen.push(((await req.json()) as { timeoutMs?: number }).timeoutMs);
			return Response.json({ ok: true });
		});
		const conn = mockConn({ RELAY: relay });
		await callRunner(conn, "/health", {});
		await callRunner(conn, "/capabilities", {});
		await callRunner(conn, "/coding/github-repos", {}); // a slow read: the relay default
		await callRunner(conn, "/health", {}, { timeoutMs: 2_000 });
		expect(seen).toEqual([READ_TIMEOUT_MS, READ_TIMEOUT_MS, undefined, 2_000]);
	});

	it("handles null JSON response from relay", async () => {
		const relay = mockRelay(async () => new Response("null", { headers: { "Content-Type": "application/json" } }));
		const conn = mockConn({ RELAY: relay });
		const result = await callRunner(conn, "/test");
		expect(result).toBeNull();
	});
});

describe("runtime node helpers", () => {
	it("normalizes runner node names and builds stable relay names", () => {
		expect(normalizeRunnerNode(" macbook ")).toBe("macbook");
		expect(relayNameForInstance("inst-1", "macbook")).toBe("inst-1:node:macbook");
		expect(relayNameForInstance("inst-1", "")).toBe("inst-1");
	});
});

const INST = "inst-1";

/**
 * An Env whose DB answers the reads the resolvers make, and whose RELAY reports `connected` only
 * for relay names in `liveNames`.
 *
 * This models the real bug in both tickets: every row it returns is a row the DB is HAPPY to
 * return — `status` is never cleared on disconnect, so the query behind these reads matches a
 * machine that has been off for months. Which machine is up is expressed ONLY through `liveNames`,
 * because that is the only place the truth lives in production too.
 */
function buildEnv(opts: {
	pin?: string;                                   // config.runnerNode (pin)
	defaultNode?: string | null;                    // instance_runtimes.runner_node
	nodes?: string[];                               // instance_runtime_nodes rows
	liveNames?: string[];                           // relay names reporting connected
	/** node -> machine_id (#379). Absent = the column is NULL, which is every legacy row. */
	machines?: Record<string, string>;
}): Env {
	const live = new Set(opts.liveNames ?? []);
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_instances")) return { config: JSON.stringify({ runnerNode: opts.pin ?? "" }) };
							if (sql.includes("FROM instance_runtimes")) {
								return opts.defaultNode
									? { endpoint_url: `http://default`, token_plaintext: "t", runner_node: opts.defaultNode, token_ciphertext: null, token_dek_wrapped: null, token_iv: null }
									: null;
							}
							if (sql.includes("FROM instance_runtime_nodes") && sql.includes("runner_node = ?3")) {
								const node = String(args[2]);
								return (opts.nodes ?? []).includes(node)
									? { endpoint_url: `http://${node}`, token_plaintext: "t", runner_node: node, token_ciphertext: null, token_dek_wrapped: null, token_iv: null }
									: null;
							}
							return null;
						},
						async all() {
							if (sql.includes("SELECT DISTINCT runner_node")) return { results: (opts.nodes ?? []).map((n) => ({ runner_node: n })) };
							// The pinned name's machine ids (#1174): which machine(s) that name is, before reading only their rows.
							if (sql.includes("SELECT DISTINCT machine_id AS id")) {
								const id = opts.machines?.[String(args[1])];
								return { results: id ? [{ id }] : [] };
							}
							// The machine-identity read (#379) — every node the USER has, with its id.
							if (sql.includes("machine_id AS machineId")) {
								return { results: (opts.nodes ?? []).map((n) => ({ node: n, machineId: opts.machines?.[n] ?? null, instanceId: INST, lastSeenAt: null })) };
							}
							return { results: [] };
						},
						async run() { return { meta: { changes: 0 } }; },
					};
				},
			};
		},
	};
	const RELAY = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({ fetch: async () => Response.json({ connected: live.has(id.name) }) }),
	};
	return { RELAY, DB } as unknown as Env;
}

describe("getRunnerConn — the contract it always documented (#532)", () => {
	// THE regression test. A session stamped to a machine that is off used to resolve here, and
	// `/coding/capture` answered `runnerConnected: true` off that resolution — for ten measured
	// hours on instance f8ddc272, across the incident that produced #530 and #531. The row is
	// present and `status != 'offline'` in EVERY case below; the only difference is the socket.
	it("a stamped node with a stale row and NO live socket resolves to null", async () => {
		const env = buildEnv({ nodes: ["Sergeys-Mac-mini.local"], liveNames: [] });
		expect(await getRunnerConn(env, INST, "u1", "Sergeys-Mac-mini.local")).toBeNull();
	});

	it("the same stamped node resolves normally once its socket is live", async () => {
		const env = buildEnv({ nodes: ["Sergeys-Mac-mini.local"], liveNames: [relayNameForInstance(INST, "Sergeys-Mac-mini.local")] });
		const conn = await getRunnerConn(env, INST, "u1", "Sergeys-Mac-mini.local");
		expect(conn?.endpointUrl).toBe("http://Sergeys-Mac-mini.local");
		expect(conn?.relayName).toBe(relayNameForInstance(INST, "Sergeys-Mac-mini.local"));
	});

	it("another machine being live does NOT make the stamped one resolve", async () => {
		// `/message`, `/end` and `/restart` address a child process that exists on ONE machine, so
		// the fix must not have quietly become a fallback: the answer for a dead stamp is null, not
		// somebody else's socket.
		const env = buildEnv({ nodes: ["mini", "laptop"], liveNames: [relayNameForInstance(INST, "laptop")] });
		expect(await getRunnerConn(env, INST, "u1", "mini")).toBeNull();
	});

	it("the default runtime row is live-checked too, on the node the ROW names", async () => {
		// `/coding/browse` reads a filesystem that only exists while that machine is up.
		const dead = buildEnv({ defaultNode: "mini", nodes: ["mini"], liveNames: [] });
		expect(await getRunnerConn(dead, INST, "u1")).toBeNull();
		const live = buildEnv({ defaultNode: "mini", nodes: ["mini"], liveNames: [relayNameForInstance(INST, "mini")] });
		expect((await getRunnerConn(live, INST, "u1"))?.endpointUrl).toBe("http://default");
	});

	it("the loader still hands back the dead machine's row — for the reclaim, which must see it", async () => {
		// `startSessionOnRunner` and the Pilot relocate a session OFF a machine that has gone away.
		// That is the one job that needs the row a live check would throw out, and it names the
		// function that gives it one rather than getting it by accident.
		const env = buildEnv({ nodes: ["mini"], liveNames: [] });
		const conn = await getRunnerConnIgnoringLiveness(env, INST, "u1", "mini");
		expect(conn?.endpointUrl).toBe("http://mini");
		expect(conn?.runnerNode).toBe("mini");
	});
});

describe("getBoundRunnerConn (live-aware routing)", () => {
	it("unpinned: routes to the default machine when its relay is live", async () => {
		const env = buildEnv({ defaultNode: "A", nodes: ["A"], liveNames: [relayNameForInstance(INST, "A")] });
		const conn = await getBoundRunnerConn(env, INST, "u1");
		expect(conn?.endpointUrl).toBe("http://default");
	});

	it("unpinned: skips a stale default (offline) and picks a live registered node — the hijack fix", async () => {
		// instance_runtimes still points at A (a machine that disconnected without clearing status),
		// but only B holds a live socket. Must route to B, not dead-end on A.
		const env = buildEnv({ defaultNode: "A", nodes: ["A", "B"], liveNames: [relayNameForInstance(INST, "B")] });
		const conn = await getBoundRunnerConn(env, INST, "u1");
		expect(conn?.endpointUrl).toBe("http://B");
	});

	it("unpinned: returns null when no machine is actually connected", async () => {
		const env = buildEnv({ defaultNode: "A", nodes: ["A", "B"], liveNames: [] });
		expect(await getBoundRunnerConn(env, INST, "u1")).toBeNull();
	});

	it("pinned: routes to the pinned machine only when its relay is live", async () => {
		const env = buildEnv({ pin: "A", nodes: ["A"], liveNames: [relayNameForInstance(INST, "A")] });
		const conn = await getBoundRunnerConn(env, INST, "u1");
		expect(conn?.endpointUrl).toBe("http://A");
	});

	it("pinned + offline: returns null (no silent fallback to another machine)", async () => {
		// Pinned to A (offline), B is live. Strict pin must NOT run on B — the agent is offline.
		const env = buildEnv({ pin: "A", nodes: ["A", "B"], liveNames: [relayNameForInstance(INST, "B")] });
		expect(await getBoundRunnerConn(env, INST, "u1")).toBeNull();
	});

	// #379. `os.hostname()` moves under the machine (DHCP, VPN, the `.local` mDNS form), so a pin
	// outlives the name it was made with. Before this, every runner call on such an instance
	// answered "run `pags up`" while `pags up` was running on that very machine with a live
	// socket. A shared `machine_id` makes "same machine" a recorded fact, so routing through the
	// new name honours the pin rather than falling back from it.
	it("pinned to a name the machine has stopped using: routes to the same machine's new name", async () => {
		const env = buildEnv({
			pin: "RLs-MacBook-Air.local",
			nodes: ["RLs-MacBook-Air.local", "Mac"],
			machines: { "RLs-MacBook-Air.local": "machine-aaaa1111", Mac: "machine-aaaa1111" },
			liveNames: [relayNameForInstance(INST, "Mac")],
		});
		const conn = await getBoundRunnerConn(env, INST, "u1");
		expect(conn?.endpointUrl).toBe("http://Mac");
		expect(conn?.runnerNode).toBe("Mac");
	});

	it("pinned + a DIFFERENT machine live: still null, even though both are registered", async () => {
		// The no-fallback contract, restated against the new code path: a distinct machine id is a
		// distinct laptop, and routing there would run the agent in a checkout the user did not pick.
		const env = buildEnv({
			pin: "laptop",
			nodes: ["laptop", "desktop"],
			machines: { laptop: "machine-aaaa1111", desktop: "machine-bbbb2222" },
			liveNames: [relayNameForInstance(INST, "desktop")],
		});
		expect(await getBoundRunnerConn(env, INST, "u1")).toBeNull();
	});

	it("pinned + offline with NO machine ids recorded: unchanged — an unprovable rename never heals", async () => {
		const env = buildEnv({ pin: "A", nodes: ["A", "B"], liveNames: [relayNameForInstance(INST, "B")] });
		expect(await getBoundRunnerConn(env, INST, "u1")).toBeNull();
	});

	it("pin UNREADABLE: returns null rather than treating it as unpinned (#325)", async () => {
		// The pin read used to `.catch(() => "")`, and "" means unpinned — so one D1 blip took the
		// exact fallback the contract above forbids: it would route to B, run the agent in a
		// checkout on a machine the user did not choose, and report that machine as online. Not
		// knowing where an agent is pinned is indistinguishable from its machine being offline.
		// Only the pin read fails; every other query answers normally and B holds a live socket, so
		// the old code routed there and looked entirely healthy doing it.
		const env = buildEnv({ pin: "A", nodes: ["A", "B"], liveNames: [relayNameForInstance(INST, "B")] });
		const inner = (env as unknown as { DB: { prepare: (sql: string) => unknown } }).DB;
		const broken = {
			...(env as unknown as Record<string, unknown>),
			DB: {
				prepare: (sql: string) =>
					sql.includes("FROM agent_instances")
						? { bind: () => ({ async first(): Promise<never> { throw new Error("D1_ERROR: network"); } }) }
						: inner.prepare(sql),
			},
		} as unknown as Env;
		expect(await getBoundRunnerConn(broken, INST, "u1")).toBeNull();
	});
});

/**
 * A plain owner-wide `instance_runtime_nodes` row, exactly the identity query reads (#1541). Lets a
 * test state ambiguity directly — two rows under one `node` string with different `machineId`s — which
 * the `buildEnv` fixture above cannot express (its `machines` map is one id per name).
 */
function idRow(node: string, machineId: string | null, opts: { instanceId?: string } = {}) {
	return { node, machineId, instanceId: opts.instanceId ?? INST, lastSeenAt: null };
}

/** An Env whose DB answers the owner-wide identity read with `rows`, and whose RELAY reports `connected` only for `liveNames`. */
function buildIdentityEnv(opts: { rows: ReturnType<typeof idRow>[]; liveNames?: string[] }): Env {
	const live = new Set(opts.liveNames ?? []);
	const DB = {
		prepare(sql: string) {
			return {
				bind(..._args: unknown[]) {
					return {
						async first() {
							// getRunnerConn's direct exact-name lookup: live iff the name is in `rows` at all.
							if (sql.includes("FROM instance_runtime_nodes") && sql.includes("runner_node = ?3")) {
								const node = String(_args[2]);
								return opts.rows.some((r) => r.node === node)
									? { endpoint_url: `http://${node}`, token_plaintext: "t", runner_node: node, token_ciphertext: null, token_dek_wrapped: null, token_iv: null }
									: null;
							}
							return null;
						},
						async all() {
							if (sql.includes("machine_id AS machineId")) return { results: opts.rows };
							return { results: [] };
						},
						async run() {
							return { meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};
	const RELAY = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({ fetch: async () => Response.json({ connected: live.has(id.name) }) }),
	};
	return { RELAY, DB } as unknown as Env;
}

/**
 * An Env whose owner-wide identity read THROWS (a D1 blip, say), and whose RELAY records every
 * name it was asked about — so a test can prove a rejected registry read never reaches the point
 * of asking the relay anything, not merely that it answers null (#1541).
 */
function buildFailingRegistryEnv(): { env: Env; relayAsked: string[] } {
	const relayAsked: string[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind() {
					return {
						async first() {
							return null;
						},
						async all() {
							if (sql.includes("machine_id AS machineId")) throw new Error("D1_ERROR: network");
							return { results: [] };
						},
						async run() {
							return { meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};
	const RELAY = {
		idFromName: (name: string) => {
			relayAsked.push(name);
			return { name };
		},
		get: (_id: { name: string }) => ({ fetch: async () => Response.json({ connected: true }) }),
	};
	return { env: { RELAY, DB } as unknown as Env, relayAsked };
}

describe("getRunnerConnForStampedNode — resolving a PAST STAMP, not a live pin (#1541)", () => {
	it("the unchanged case: the stamped name is still live, no identity lookup needed", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", "m-1")], liveNames: [relayNameForInstance(INST, "mini")] });
		const conn = await getRunnerConnForStampedNode(env, INST, "u1", "mini");
		expect(conn?.endpointUrl).toBe("http://mini");
	});

	it("renamed original machine: the stamp is dead, but a proven alias of the SAME machine is live", async () => {
		// THE issue's exact shape: `Sergeys-Mac-mini.local` stamped a session; the machine now answers as `Macmini.modem`.
		const env = buildIdentityEnv({
			rows: [idRow("Sergeys-Mac-mini.local", "mac-mini-id"), idRow("Macmini.modem", "mac-mini-id")],
			liveNames: [relayNameForInstance(INST, "Macmini.modem")],
		});
		const conn = await getRunnerConnForStampedNode(env, INST, "u1", "Sergeys-Mac-mini.local");
		expect(conn?.endpointUrl).toBe("http://Macmini.modem");
		expect(conn?.runnerNode).toBe("Macmini.modem");
	});

	it("a different machine being live does not make the stamp resolve — no shared machine_id, no candidate", async () => {
		const env = buildIdentityEnv({
			rows: [idRow("mini", "mac-mini-id"), idRow("dell-laptop", "dell-id")],
			liveNames: [relayNameForInstance(INST, "dell-laptop")],
		});
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("unknown alias: the stamped name carries no recorded machine_id — no candidate, even if another name is live", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", null), idRow("other", "some-id")], liveNames: [relayNameForInstance(INST, "other")] });
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("ambiguous alias: the stamped name itself is shared by two machines — refuses every candidate rather than guessing", async () => {
		const env = buildIdentityEnv({
			rows: [idRow("mini", "machine-a"), idRow("mini", "machine-b"), idRow("alias-of-a", "machine-a"), idRow("alias-of-b", "machine-b")],
			liveNames: [relayNameForInstance(INST, "alias-of-a"), relayNameForInstance(INST, "alias-of-b")],
		});
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("an answeredBy candidate that is ITSELF ambiguous elsewhere in the fleet is never offered, even though it shares the stamp's id", async () => {
		// `shared-name` carries mac-mini-id (same as the stamp) AND a second, unrelated id under a
		// different instance — two real machines answering to the same hostname. Proving the stamp's
		// id alone is not enough; the candidate's OWN identity must be unambiguous too.
		const env = buildIdentityEnv({
			rows: [idRow("mini", "mac-mini-id"), idRow("shared-name", "mac-mini-id"), idRow("shared-name", "other-machine-id", { instanceId: "other-inst" })],
			liveNames: [relayNameForInstance(INST, "shared-name")],
		});
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("unreachable runner: a proven alias exists but nothing is actually connected", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", "mac-mini-id"), idRow("desktop", "mac-mini-id")], liveNames: [] });
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("a known-ambiguous stamped name is refused outright, even though SOMETHING is live under the exact string", async () => {
		// Two real machines have answered to "mini" at different times; a live exact-name socket right
		// now proves nothing about which one this record meant. The direct lookup must never even be
		// attempted — zero stop calls to a name the fleet's own history contradicts.
		const env = buildIdentityEnv({
			rows: [idRow("mini", "machine-a"), idRow("mini", "machine-b")],
			liveNames: [relayNameForInstance(INST, "mini")],
		});
		expect(await getRunnerConnForStampedNode(env, INST, "u1", "mini")).toBeNull();
	});

	it("a rejected owner registry read never dispatches — the failure propagates, it is not read as 'nothing recorded'", async () => {
		const { env, relayAsked } = buildFailingRegistryEnv();
		await expect(getRunnerConnForStampedNode(env, INST, "u1", "mini")).rejects.toThrow(/D1_ERROR/);
		expect(relayAsked).toEqual([]); // never even asked whether "mini" (or anything) is live
	});
});

describe("sameMachine — the independent proof before a lock is released on who answered (#1541)", () => {
	it("exact string match is proof when nothing recorded contradicts it", async () => {
		expect(await sameMachine(buildIdentityEnv({ rows: [] }), "u1", "mini", "mini")).toBe(true);
		expect(await sameMachine(buildIdentityEnv({ rows: [idRow("mini", null)] }), "u1", "mini", "mini")).toBe(true);
	});

	it("a rejected owner registry read never proves sameness — the failure propagates, it cannot release a claim", async () => {
		const { env } = buildFailingRegistryEnv();
		await expect(sameMachine(env, "u1", "mini", "mini")).rejects.toThrow(/D1_ERROR/);
	});

	it("exact string match is REFUSED when the name is known-ambiguous — a recorded contradiction beats the string", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", "machine-a"), idRow("mini", "machine-b")] });
		expect(await sameMachine(env, "u1", "mini", "mini")).toBe(false);
	});

	it("a renamed original machine proves the same via its recorded machine_id", async () => {
		const env = buildIdentityEnv({ rows: [idRow("Sergeys-Mac-mini.local", "mac-mini-id"), idRow("Macmini.modem", "mac-mini-id")] });
		expect(await sameMachine(env, "u1", "Sergeys-Mac-mini.local", "Macmini.modem")).toBe(true);
	});

	it("a different machine never proves the same, even though both are registered", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", "mac-mini-id"), idRow("dell-laptop", "dell-id")] });
		expect(await sameMachine(env, "u1", "mini", "dell-laptop")).toBe(false);
	});

	it("an unknown stamp (no recorded machine_id) never proves a rename", async () => {
		const env = buildIdentityEnv({ rows: [idRow("mini", null), idRow("other", "some-id")] });
		expect(await sameMachine(env, "u1", "mini", "other")).toBe(false);
	});

	it("an ambiguous stamp (two machines share the name) refuses, rather than matching either", async () => {
		const env = buildIdentityEnv({
			rows: [idRow("mini", "machine-a"), idRow("mini", "machine-b"), idRow("alias-of-a", "machine-a")],
		});
		expect(await sameMachine(env, "u1", "mini", "alias-of-a")).toBe(false);
	});

	it("an answeredBy name that is itself ambiguous elsewhere in the fleet is rejected, not just the stamp's own ambiguity", async () => {
		const env = buildIdentityEnv({
			rows: [idRow("mini", "mac-mini-id"), idRow("shared-name", "mac-mini-id"), idRow("shared-name", "other-machine-id", { instanceId: "other-inst" })],
		});
		expect(await sameMachine(env, "u1", "mini", "shared-name")).toBe(false);
	});

	it("null/empty names never match", async () => {
		const env = buildIdentityEnv({ rows: [] });
		expect(await sameMachine(env, "u1", null, "mini")).toBe(false);
		expect(await sameMachine(env, "u1", "mini", undefined)).toBe(false);
		expect(await sameMachine(env, "u1", "", "")).toBe(false);
	});
});
