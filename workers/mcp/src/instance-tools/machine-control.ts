import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
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

	// ── Remote force-reattach (#856) ────────────────────────────────────────────
	//
	// An agent whose socket went stale — a frozen or duplicate runner holding its relay slot, or a
	// runner that lost a 4409 and blocked it — could only be recovered by `pags up --force` typed at the
	// machine. This is that, remotely and for ONE agent: the stale socket is cleared from the agent's
	// slot, and the machine's connected `pags up` is told to attach this agent and take its slot over.
	server.tool(
		"force_runner_attach",
		"Force a machine's connected `pags up` to (re)attach ONE agent now — the remote equivalent of `pags up --force`, scoped to this instance. Use it when instance_runner_node shows the machine online (`nodeOnline: true`) but this agent not connected, when a start fails with \"another runner on it may already hold this agent\", or when set_instance_runner_node's `attachment.detail` names this tool. It clears a stale socket from the agent's relay slot (only one that answers no ping — a live one is taken over by the runner, not killed), then asks the machine's runner, over a socket that answers there, to attach this agent with force. Targets the machine the agent is pinned to unless `runner_node` names another; it does NOT change the pin (set_instance_runner_node does). Answers `{node, attached, evicted, detail?}` from the relay's own view; when `attached` is false, `detail` is the specific reason — e.g. every socket on that machine is frozen, or the machine may not run this agent. Needs a `pags up` running on the machine; it cannot start one.",
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
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ runnerNode: runner_node || undefined }) }, env)) as {
				attached?: boolean;
				error?: string;
			};
			if (!data.error) await audit(safetyFor(token), { tool: "force_runner_attach", action: "completed", input, result: data });
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
		"Update a machine's `pags` CLI to the latest release and restart it in place — entirely remotely. Use it when list_runner_nodes or instance_runner_node shows a machine `behind` on a feature, or when an error names runner_update (e.g. coding_repo_add \"too old to clone\"). The machine installs `@proagentstore/cli@latest` with npm and restarts under its `pags up`; if any coding engine is mid-turn it WAITS until those turns finish (answer `scheduled`, with `waitingFor`), so a run is paused across the restart and resumed — never cut off. After a restart the answer says which agents it held, which came back, which had to be re-attached (the force_runner_attach path), and any still `missing` with the reason. Other answers: `up-to-date`, `refused` (with why — e.g. not started by a `pags up` that can restart it), `unsupported` (a CLI too old to update itself: the FIRST update needs the machine, later ones do not), `unreachable`. Pass dry_run to see what would be asked without contacting the machine; list_runner_nodes shows its current version and what it is behind on.",
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
					effect: `${runner_node} would install the latest @proagentstore/cli and restart under its \`pags up\` — after any engine mid-turn finishes — and every agent it holds would be checked back in, re-attaching any that did not return.`,
				});
			}
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({}) }, env)) as { action?: string; error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "runner_update", action: "completed", input, result: { action: data.action } });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
