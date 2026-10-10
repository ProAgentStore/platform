import { authedAsyncCall } from "../async-outcome.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Remote control of the MACHINES themselves (#856, #859) — acting on a runner, not reading one.
 *
 * `force_runner_attach` takes an agent's relay slot over on a machine (the remote `pags up --force`),
 * and `runner_update` updates a machine's `pags` CLI and restarts it in place. Split out of
 * `runtime.ts`, which reads and pins machines, when these two took it past the file-size ratchet:
 * both share one property its other tools do not — they make a runner on somebody's machine DO
 * something — and both are `runtime`-scoped for that reason.
 */
export function registerMachineControlTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	// ── Per-machine automatic-update policy (#859) ─────────────────────────────
	//
	// This is platform policy, keyed by the stable physical machine id rather than a runner's
	// mutable hostname.  It deliberately lives beside `runner_update`: the owner needs both the
	// one-off escape hatch and the durable opt-in that tells a reconnecting runner whether it may
	// update itself.  Reading the detail route, rather than a policy-only projection, also leaves
	// the caller with the version and lifecycle state needed to understand the setting it changes.
	server.tool(
		"get_machine_policy",
		"Read one physical machine's Auto-update policy and current update detail (#859). `machine_id` is the stable id from the terminals machine detail/list, not a hostname or an agent id, so every hostname alias and every attached agent sees the same owner-scoped policy. Returns the machine detail including `auto_update_policy`, current and latest CLI versions, and `auto_update_status`. Read this before changing the policy; a missing stored policy resolves to Auto-update OFF for existing machines.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from the terminals fleet/detail response; do not use a hostname alias."),
		},
		async ({ token, machine_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { machine_id };
			const denied = await requirePermission(safetyFor(token), "read", "get_machine_policy", input);
			if (denied) return denied;
			const data = (await authedCall(`/v1/terminals/machines/${encodeURIComponent(machine_id)}`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_machine_policy",
		"Enable or disable Auto-update for one physical machine (#859). The setting is owner-scoped and keyed by stable `machine_id`, so it survives offline periods, runner reconnects, attached-agent changes, and hostname aliases. Existing machines default OFF. Enabling permits an idle runner to check trusted CLI releases and use its safe self-update/restart path; it does not interrupt coding or local application work. Disabling is persisted immediately; a runner rechecks the policy before installation and cancels an update that has not started. Use get_machine_policy to read back the saved policy and lifecycle state.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from the terminals fleet/detail response; do not use a hostname alias."),
			auto_update: z.boolean().describe("Whether this physical machine may automatically update its PAGS CLI while idle."),
			dry_run: z.boolean().optional().describe("Report the saved policy change without changing it."),
		},
		async ({ token, machine_id, auto_update, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { machine_id, auto_update };
			const denied = await requirePermission(safetyFor(token), "write", "set_machine_policy", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/machines/${encodeURIComponent(machine_id)}/policy`;
			if (dry_run) {
				return dryRun(safetyFor(token), "set_machine_policy", `${auto_update ? "enable" : "disable"} Auto-update for ${machine_id}`, input, {
					endpoint,
					method: "PUT",
					body: { auto_update },
				});
			}
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify({ auto_update }) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "set_machine_policy", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── Remote force-reattach (#856) ────────────────────────────────────────────
	//
	// An agent whose socket went stale — a frozen or duplicate runner holding its relay slot, or a
	// runner that lost a 4409 and blocked it — could only be recovered by `pags up --force` typed at the
	// machine. This is that, remotely and for ONE agent: the stale socket is cleared from the agent's
	// slot, and the machine's connected `pags up` is told to attach this agent and take its slot over.
	server.tool(
		"force_runner_attach",
		"Force a machine's connected `pags up` to (re)attach ONE agent now — the remote equivalent of `pags up --force`, scoped to this instance. Use it when instance_runner_node shows the machine online (`nodeOnline: true`) but this agent not connected, when coding_diagnostics reports an unresponsive runner with a connected relay (a stale agent socket may recover through this path), when a start fails with \"another runner on it may already hold this agent\", or when set_instance_runner_node's `attachment.detail` names this tool. It clears a stale socket from the agent's relay slot (only one that answers no ping — a live one is taken over by the runner, not killed), then asks the machine's runner, over a socket that answers there, to attach this agent with force. Targets the machine the agent is pinned to unless `runner_node` names another; it does NOT change the pin (set_instance_runner_node does). Answers `{node, attached, evicted, detail?}` from the relay's own view; when `attached` is false, `detail` is the specific reason — e.g. every socket on that machine is frozen, or the machine may not run this agent. When the machine has not confirmed within 15s the relay is asked once more: `{node, attached: true}` if the agent's socket is already live there, else `{attached: false, unconfirmed: true, detail}`. An interrupted or slow confirmation answers `{outcome: unknown, confirmation: {reason, httpStatus?}, possibleOutcomes, poll}`; eviction or attachment may already have happened, so poll instance_runner_node before retrying. Needs a `pags up` running on the machine; it cannot start one.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID or slug"),
			runner_node: z.string().optional().describe("Machine (node) name to attach on, from instance_runner_node's `nodes`. Omit to use the machine the agent is pinned to."),
			dry_run: z.boolean().optional().describe("Report which machine would be asked, without asking it."),
		},
		async ({ token, instance_id, runner_node, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, runner_node };
			// `runtime`: it drives a machine — closes a relay socket and makes a runner reconnect.
			const denied = await requirePermission(safetyFor(token), "runtime", "force_runner_attach", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/runner-attach`;
			if (dry_run) {
				return dryRun(safetyFor(token), "force_runner_attach", `force ${instance_id} to attach on ${runner_node || "its pinned machine"}`, input, {
					endpoint,
					method: "POST",
					effect: `${runner_node || "The machine this agent is pinned to"} would have any stale socket cleared from this agent's slot and its \`pags up\` told to attach the agent now, taking the slot over.`,
				});
			}
			const data = (await authedAsyncCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runnerNode: runner_node || undefined }) }, env, { tool: "force_runner_attach", possibleOutcomes: ["not-started", "evicted", "attaching", "attached"], poll: { tool: "instance_runner_node", input: { instance_id } } })) as {
				attached?: boolean;
				error?: string;
				outcome?: string;
			};
			if (!data.error) await audit(safetyFor(token), { tool: "force_runner_attach", action: data.outcome === "unknown" ? "unconfirmed" : "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── Remote runner update (#859) ─────────────────────────────────────────────
	//
	// Every runner-side feature was unusable until someone updated `pags` at each machine. This asks a
	// connected machine to update its own CLI to the latest release and restart in place — waiting for
	// busy engines first, so a run is parked across the gap and resumed, never cut off — and then checks
	// every agent the machine held is attached again, re-attaching stragglers through #856's path.
	server.tool(
		"runner_update",
		"Update a machine's `pags` CLI to the latest release and restart it in place — entirely remotely. Use it when list_runner_nodes or instance_runner_node shows a machine `behind` on a feature, or when an error names runner_update (e.g. coding_repo_add \"too old to clone\"). The machine installs `@proagentstore/cli@latest` with npm and restarts — `pags up` restarts itself on the new release (an older `pags up` restarts only the runner, and the answer's `supervisor` says so), and a runner not under `pags up` restarts through its launchd/systemd unit (PAGS_SERVICE=1) or its PAGS_RESTART_COMMAND; if any coding engine is mid-turn it WAITS until those turns finish (answer `scheduled`, with `waitingFor`), so a run is paused across the restart and resumed — never cut off. After a restart the answer says which agents it held, which came back, which had to be re-attached (the force_runner_attach path), and any still `missing` with the reason. Other answers: `up-to-date`, `refused` (with why — e.g. nothing on the machine would restart it), `unsupported` (a CLI too old to update itself: the FIRST update needs the machine, later ones do not), `unreachable`. The update is a DURABLE operation (#990): this call records it, starts it, and answers at once with `{operationId, state, poll}` — `state` is `running` while it is in flight and then one of `scheduled`, `restarting`, `restarted`, `up_to_date`, `refused`, `unsupported`, `unreachable` or `failed`, each with the machine's own reason. Read the outcome with runner_update_status (or `update` on the machine's row in list_runner_nodes); an interrupted or slow confirmation can no longer make it unknowable. Only ONE update runs per machine at a time: calling again while one is in flight answers that operation with `started: false` rather than installing twice. Pass dry_run to see what would be asked without contacting the machine; list_runner_nodes shows its current version and what it is behind on.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			runner_node: z.string().describe("Machine (node) name to update, from list_runner_nodes or instance_runner_node's `nodes`."),
			dry_run: z.boolean().optional().describe("Report what would be asked of the machine, without contacting it."),
		},
		async ({ token, runner_node, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { runner_node };
			// `runtime`: it installs software on the machine and restarts its runner.
			const denied = await requirePermission(safetyFor(token), "runtime", "runner_update", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/nodes/${encodeURIComponent(runner_node)}/update`;
			if (dry_run) {
				return dryRun(safetyFor(token), "runner_update", `update and restart the runner on ${runner_node}`, input, {
					endpoint,
					method: "POST",
					effect: `${runner_node} would install the latest @proagentstore/cli and restart — after any engine mid-turn finishes — and every agent it holds would be checked back in, re-attaching any that did not return.`,
				});
			}
			// The route now claims the operation and returns immediately, so this reply arrives well
			// inside the confirmation deadline. The async-outcome wrapper stays as the transport
			// safety net — and its `poll` hint names the tool that reads the durable outcome.
			const data = (await authedAsyncCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({}) }, env, { tool: "runner_update", possibleOutcomes: ["running", "scheduled", "restarting", "restarted", "refused", "unsupported", "unreachable", "up_to_date", "failed"], poll: { tool: "runner_update_status", input: { runner_node } } })) as { action?: string; error?: string; outcome?: string; state?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "runner_update", action: data.outcome === "unknown" ? "unconfirmed" : "completed", input, result: { action: data.action ?? data.state } });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── The durable outcome (#990) ───────────────────────────────────────────────
	//
	// `runner_update` used to be answerable only by the reply to its own request, and that reply
	// could be lost: two live attempts on an idle machine returned `outcome: "unknown"` and left the
	// node on its old CLI with no outcome and no error recorded anywhere. This reads the operation.
	server.tool(
		"runner_update_status",
		"The outcome of the latest `pags` CLI update on one machine (#990) — what to call after runner_update, and the thing to read when its reply was slow, interrupted or answered `outcome: unknown`. Answers `{node, state, operation}`: `state` is `running` while the update is in flight, then one of `scheduled` (waiting for a busy engine to finish its turn), `restarting`, `restarted`, `up_to_date`, `would_update` (a dry run), `refused`, `unsupported` (a CLI too old to update itself — the first update needs the machine), `unreachable` or `failed`. The operation carries the versions it moved between, the version the machine registered after it came back, the agents it held, which were re-attached, any still missing with each one's reason, what restarted it, and the owner-facing reason. Read-only; `null` when no update has ever been asked for on that machine.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			runner_node: z.string().describe("Machine (node) name, from list_runner_nodes or the `node` runner_update answered with."),
		},
		async ({ token, runner_node }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "runner_update_status", { runner_node });
			if (denied) return denied;
			const data = (await authedCall(`/v1/terminals/nodes/${encodeURIComponent(runner_node)}/update`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
