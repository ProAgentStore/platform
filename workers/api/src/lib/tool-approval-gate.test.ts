/**
 * The per-call approval gate, end to end at the boundaries that matter (#722 Step 2, #90 AC2).
 *
 * Four properties are pinned here, and each of them is a way the gate could be worth nothing:
 *
 *  1. An `ask`-mode write does NOT reach its handler. Not "is logged", not "is warned about" —
 *     the send does not happen.
 *  2. Every existing grant is untouched. `always` is the column default and the absence of a mode
 *     reads as `always`, so nobody who did not opt in is put behind a queue. Measured at decision
 *     time: `ask` by default would have queued 23 Coder instances on day one.
 *  3. An agent cannot raise its own `call_tool` ticket. If it could, a refused write becomes
 *     "file the approval yourself and wait for a click", and the gate is a formality.
 *  4. A ticket cannot outlive the consent it was granted under. The gate is evaluated when the
 *     card is written and the human clicks later; re-checking only at creation would leave a
 *     stored, approvable, un-gated write.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_ONLY_TICKET_ACTIONS, readCallToolTicket, readTicketAction, validateTicketAction } from "./actionable-ticket.js";
import { CONNECTION_ACTIONS } from "./connections.js";
import { recheckCallToolTicket } from "./tool-approval-run.js";
import { TOOL_APPROVAL_TASK_TYPE } from "./tool-approval.js";
import { runRegistryTool } from "./tool-registry.js";
import { TRIGGER_ACTIONS } from "./trigger-types.js";
import type { Env } from "../types.js";

// `.href` — a STRING — not the URL object. Under `tsconfig.test.json` the Workers `URL` global and
// Node's `url.URL` are different types, so passing the object fails a typecheck that
// `pnpm -r typecheck` does not run. Same form as `portal-watch-seed.test.ts:19`, for the same reason.
const migration = () =>
	readFileSync(fileURLToPath(new URL("../../migrations/0155_connector_consent_mode.sql", import.meta.url).href), "utf8");

interface Written { sql: string; args: unknown[] }

/**
 * An env whose consent row carries `mode`, recording every write.
 *
 * `mode: null` models a row written before migration 0155 — D1 backfills the DEFAULT, but reading
 * it as null is the harsher case and the one that must still resolve to `always`.
 */
function envWithMode(mode: string | null | undefined, opts: { pending?: unknown[] } = {}): { env: Env; writes: Written[] } {
	const writes: Written[] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				const all = async () => ({ results: sql.includes("instance_runtime_tasks") ? (opts.pending ?? []) : [] });
				const first = async () => {
					if (sql.includes("instance_connector_consent")) return mode === undefined ? null : { mode };
					// The capability-constraint join (#441) must LOCATE the instance or it fail-closes
					// before the consent gate is ever reached.
					if (sql.includes("agent_instances")) return { agent_config: "{}", instance_config: "{}" };
					return null;
				};
				return {
					all,
					first,
					bind(...args: unknown[]) {
						return { all, first, async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; } };
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes };
}

const ctx = (env: Env) => ({ env, instanceId: "inst-1", userId: "u1" });
const send = { to: "hr@example.com", subject: "Hi", body: "Hello." };

describe("the ask-gate holds the call back", () => {
	it("an ask-mode gmail_send is QUEUED, not sent", async () => {
		const { env, writes } = envWithMode("ask");
		const res = await runRegistryTool("gmail_send", ctx(env), send);

		// The proof that nothing was sent is negative and has to be: no Gmail token was minted and
		// no handler ran, so the only positive evidence available is the board write.
		expect(res.content.startsWith("Nothing has been sent.")).toBe(true);
		const card = writes.find((w) => w.sql.includes("instance_runtime_tasks"));
		expect(card, "an ask-mode write must leave a card behind").toBeTruthy();
		const payload = JSON.parse(String(card!.args.find((a) => typeof a === "string" && a.includes("call_tool"))));
		expect(payload.type).toBe(TOOL_APPROVAL_TASK_TYPE);
		expect(payload.status).toBe("needs_approval");
		expect(payload.action).toEqual({ action: "call_tool", config: {}, params: { tool: "gmail_send", args: send } });
		// The card carries the actual message, or the approval is theatre.
		expect(payload.description).toContain("hr@example.com");
		expect(payload.description).toContain("Hello.");
	});

	it("reports success:true — being queued is not an error the model should route around", async () => {
		// A `false` here reads to a model as "that failed", and the observed responses to that are
		// retrying, reaching for another tool, or apologising for a failure that did not happen.
		const { env } = envWithMode("ask");
		expect((await runRegistryTool("gmail_send", ctx(env), send)).success).toBe(true);
	});

	it("the SAME call queued twice leaves ONE card", async () => {
		const existing = [{ id: "t-existing", payload: JSON.stringify({ approvalKey: `gmail_send:${JSON.stringify({ body: "Hello.", subject: "Hi", to: "hr@example.com" })}` }) }];
		const { env, writes } = envWithMode("ask", { pending: existing });
		// Argument order deliberately differs from the stored key's — the same call, however it was
		// built. An owner facing two identical cards cannot tell a duplicate from a second send.
		const res = await runRegistryTool("gmail_send", ctx(env), { body: "Hello.", to: "hr@example.com", subject: "Hi" });
		expect(res.content).toContain("already queued");
		expect(res.content).toContain("t-existing");
		expect(writes.some((w) => w.sql.includes("INSERT INTO instance_runtime_tasks"))).toBe(false);
	});

	it("REFUSES rather than sends when there is no owner to put the card in front of", async () => {
		// The one fall-through that would be fatal: a gate whose own bookkeeping fails must not
		// resolve to "send it anyway".
		//
		// Reached via a missing USER, not a missing instance: consent is keyed by instance, so a
		// call with no instance has already been refused by the consent gate above and can never
		// arrive here. That half of the guard is defence-in-depth and is stated as such in the code.
		const { env } = envWithMode("ask");
		const res = await runRegistryTool("gmail_send", { env, instanceId: "inst-1" }, send);
		expect(res.success).toBe(false);
		expect(res.content).toContain("refused rather than sent");
	});

	it("REFUSES rather than sends when the card itself cannot be written", async () => {
		const { env } = envWithMode("ask");
		const broken = {
			...env,
			DB: { ...env.DB, prepare: (sql: string) => (sql.includes("INSERT INTO instance_runtime_tasks") ? (() => { throw new Error("db down"); })() : env.DB.prepare(sql)) },
		} as unknown as Env;
		const res = await runRegistryTool("gmail_send", ctx(broken), send);
		expect(res.success).toBe(false);
		expect(res.content).toContain("refused rather than sent");
	});
});

describe("nobody who did not opt in is affected", () => {
	it("mode `always` dispatches — the gate is not in the way", async () => {
		const { env, writes } = envWithMode("always");
		const res = await runRegistryTool("gmail_send", ctx(env), send);
		// It fails for want of a real Gmail credential, which is proof it got PAST the gate to the
		// handler — the gate's own refusals never mention the connector's own machinery.
		expect(res.content.startsWith("Nothing has been sent.")).toBe(false);
		expect(writes.some((w) => w.sql.includes("instance_runtime_tasks"))).toBe(false);
	});

	it("a row predating migration 0155 reads as `always`", async () => {
		const { env } = envWithMode(null);
		expect((await runRegistryTool("gmail_send", ctx(env), send)).content.startsWith("Nothing has been sent.")).toBe(false);
	});

	it("no consent row at all is still a REFUSAL, not a queue", async () => {
		// Off must keep exactly one meaning. Queuing an ungranted write would silently upgrade
		// "this agent may not do that" into "ask me about it".
		const { env } = envWithMode(undefined);
		const res = await runRegistryTool("gmail_send", ctx(env), send);
		expect(res.success).toBe(false);
		expect(res.content).toContain("isn't permitted");
	});

	it("the migration defaults the column to `always` and does not backfill anything else", () => {
		const sql = migration();
		expect(sql).toMatch(/ALTER TABLE instance_connector_consent ADD COLUMN mode TEXT NOT NULL DEFAULT 'always'/);
		expect(sql).not.toMatch(/UPDATE\s+instance_connector_consent/i);
	});
});

describe("only the gate may raise a call_tool ticket", () => {
	it("refuses call_tool from a caller that does not hold the gate's key", () => {
		// `create_ticket` (a tool an agent calls) and POST /tasks/direct both validate without
		// `allowGateOnly`. If this passed, a refused write would become: file the approval
		// yourself, wait for a click, obtain the dispatch the gate withheld.
		const err = validateTicketAction("call_tool", {}, { tool: "gmail_send", args: send });
		expect(err).toContain("raised by the platform's approval gate");
	});

	it("does not even ADVERTISE call_tool in the list of actions a caller may choose", () => {
		const err = validateTicketAction("nonsense", {}, {});
		expect(err).toContain("run_pipeline");
		expect(err).not.toContain("call_tool");
	});

	it("accepts it from the gate, and insists the call is named", () => {
		expect(validateTicketAction("call_tool", {}, { tool: "gmail_send", args: send }, { allowGateOnly: true })).toBeNull();
		expect(validateTicketAction("call_tool", {}, { args: send }, { allowGateOnly: true })).toContain("params.tool");
	});

	it("is unreachable from a trigger, a cron or an agent-to-agent connection", () => {
		// Enforced by the TYPE (`TicketActionName` widens `TriggerAction`, never the reverse), and
		// pinned here because the type is the kind of thing a later cast can quietly undo.
		expect(GATE_ONLY_TICKET_ACTIONS.has("call_tool")).toBe(true);
		expect([...TRIGGER_ACTIONS]).not.toContain("call_tool");
		expect([...CONNECTION_ACTIONS]).not.toContain("call_tool");
	});

	it("readCallToolTicket refuses a ticket whose call cannot be read", () => {
		// Degrade to "not runnable", never to a call with guessed arguments.
		expect(readCallToolTicket(readTicketAction({ action: { action: "call_tool", params: {} } }))).toBeNull();
		expect(readCallToolTicket(readTicketAction({ action: { action: "run_pipeline", config: { pipeline: "p" } } }))).toBeNull();
		expect(readCallToolTicket(readTicketAction({ action: { action: "call_tool", params: { tool: "gmail_send" } } }))).toEqual({
			tool: "gmail_send",
			args: {},
		});
	});
});

describe("a ticket cannot outlive the consent it was granted under", () => {
	/** An env whose tool listing resolves, with the consent rows the owner holds RIGHT NOW. */
	function policyEnv(opts: { consents: string[]; disabled?: string[] }): Env {
		return {
			DB: {
				prepare(sql: string) {
					const all = async () => ({
						results: sql.includes("instance_connector_consent")
							? opts.consents.map((connector) => ({ connector, scope: "write" }))
							: [],
					});
					return {
						all,
						bind() {
							return {
								all,
								first: async () =>
									sql.includes("agent_instances")
										? {
												slug: "inbox-chat",
												category: null,
												config: JSON.stringify({ capabilities: { tools: ["gmail_send"] } }),
												instance_config: JSON.stringify({ disabledTools: opts.disabled ?? [] }),
											}
										: null,
							};
						},
					};
				},
			},
			AGENT: { idFromName: () => "id", get: () => ({ fetch: async () => new Response("{}") }) },
		} as unknown as Env;
	}

	const call = { tool: "gmail_send", args: send };

	it("lets an unchanged, still-consented call through", async () => {
		expect(await recheckCallToolTicket(policyEnv({ consents: ["gmail"] }), "inst-1", "u1", call)).toBeNull();
	});

	it("blocks it when the connector's write access was revoked after it was queued", async () => {
		// THE sharpest edge in the design: the gate was checked when the card was written and the
		// human clicks later. Checking only at creation leaves a stored, approvable, un-gated write.
		const refusal = await recheckCallToolTicket(policyEnv({ consents: [] }), "inst-1", "u1", call);
		expect(refusal).toContain("revoked");
	});

	it("blocks it when the owner switched the tool off", async () => {
		const refusal = await recheckCallToolTicket(policyEnv({ consents: ["gmail"], disabled: ["gmail_send"] }), "inst-1", "u1", call);
		expect(refusal).toContain("switched off");
	});

	it("blocks a tool the agent no longer declares", async () => {
		const refusal = await recheckCallToolTicket(policyEnv({ consents: ["gmail"] }), "inst-1", "u1", { tool: "made_up_tool", args: {} });
		expect(refusal).toContain("no longer one of this agent's tools");
	});

	it("blocks when the policy cannot be read at all — fail-closed", async () => {
		const broken = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
		expect(await recheckCallToolTicket(broken, "inst-1", "u1", call)).toContain("could not be read");
	});
});
