import { authedAsyncCall } from "../async-outcome.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
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
		"Read one physical machine's name, Auto-update policy and current update detail (#859, #1250). `displayName` is your name for it (null until set with set_machine_policy), `node` its current hostname, `aka` its other hostnames. `machine_id` is the stable id from the terminals machine detail/list, not a hostname or an agent id, so every hostname alias and every attached agent sees the same owner-scoped policy. Returns the machine detail including `auto_update_policy`, current and latest CLI versions, and `auto_update_status`. Read this before changing the policy; a missing stored policy resolves to Auto-update OFF for existing machines. `auto_update_stuck` (#1034) is set when the policy is ON, the machine is connected, and it has stayed behind a published release for over a day (or its own release check stopped advancing). In that case `auto_update_status`, the runner's own record, may still read `waiting_for_idle`. The remedy is one runner_update for that machine.",
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

	// ── Native desktop / Maestro readiness (#1057, slice 1) ──────────────────────
	//
	// READ-ONLY. It asks the instance's live runner what native control could do on its machine —
	// macOS/Windows permission state, Maestro, connected devices — and changes nothing, installs
	// nothing, prompts for nothing. It is refused with NATIVE_NOT_ENABLED until the OWNER has opted
	// that machine in (per machine, after the account-risk disclosure); MCP cannot opt a machine in.
	server.tool(
		"native_preflight",
		"Check whether the machine running this instance's runner is ready for native desktop app control or Maestro phone/emulator automation (#1057). Read-only: reports OS, desktop permission state (macOS Screen Recording + Accessibility, Windows UI Automation), whether Maestro/adb/simctl are present, connected devices, and stable error codes (NATIVE_PERMISSIONS_MISSING, NATIVE_MAESTRO_NOT_INSTALLED, NATIVE_DEVICE_NOT_FOUND). Refused with NATIVE_NOT_ENABLED until the owner opts that machine in; NATIVE_RUNNER_UNSUPPORTED/UNREACHABLE when the runner is too old or gone. Nothing is driven, installed or granted.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID; its live runner's machine is the one checked."),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id };
			const denied = await requirePermission(safetyFor(token), "read", "native_preflight", input);
			if (denied) return denied;
			return jsonText(await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/native/preflight`, sessionToken, {}, env));
		},
	);

	server.tool(
		"set_machine_policy",
		"Name a machine, and/or enable or disable its Auto-update (#859, #1250). `display_name` is your name for the machine (e.g. \"rl-laptop\") — unique across your machines, case-insensitively (a name another machine has is refused with 409); a blank clears it. Every runner tool then shows it first, with the hostnames as aliases, and set_instance_runner_node accepts it. Renaming never moves a pin: pins hold the machine id. Give display_name, auto_update, or both. Auto-update: the setting is owner-scoped and keyed by stable `machine_id`, so it survives offline periods, runner reconnects, attached-agent changes, and hostname aliases. Existing machines default OFF. Enabling permits an idle runner to check trusted CLI releases and use its safe self-update/restart path; it does not interrupt coding or local application work. Disabling is persisted immediately; a runner rechecks the policy before installation and cancels an update that has not started. Use get_machine_policy to read back the saved policy and lifecycle state. Post-run cleanup (#1265): `cleanup_mode` is \"gentle\" (the default; the runner touches only processes and files it can prove it started — descendants of a session's engine, processes carrying its session marker, Playwright's own browser profiles, the run's temp folder and worktrees — and only REPORTS other leftovers) or \"harsh\" (for a dedicated runner: it also kills the whole process group, sweeps orphaned node/vite/jest/esbuild/wrangler processes running out of runner workdirs, reaps stale temp and browser profiles every 15 minutes, and prunes package caches and git-ignored build outputs when the disk is over 90%). Neither mode touches a live session, a person's own browser, or uncommitted work. Changing the mode resets the six switches to its defaults; `cleanup_overrides` sets any of processGroupKill, leftoverSweep, browserCleanup, tempCleanup, loadWarning, cachePruning to true/false (null returns one to the default). `cleanup_now` asks the machine to run one cleanup pass on its next heartbeat; get_machine_policy / list_runner_nodes then show the runner's report (leftovers found, bytes freed).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from the terminals fleet/detail response; do not use a hostname alias."),
			auto_update: z.boolean().optional().describe("Whether this physical machine may automatically update its PAGS CLI while idle. Omit to leave it unchanged."),
			display_name: z.string().optional().describe("Your name for this machine, 1-40 characters (letters, digits, spaces, . _ -), unique across your machines. Empty string clears it. Omit to leave it unchanged."),
			cleanup_mode: z.enum(["gentle", "harsh"]).optional().describe("Post-run cleanup mode for this machine (#1265). gentle (default) touches only what the runner provably started; harsh is for a dedicated runner. Changing it resets the switches to the mode's defaults. Omit to leave it unchanged."),
			cleanup_overrides: z.record(z.enum(["processGroupKill", "leftoverSweep", "browserCleanup", "tempCleanup", "loadWarning", "cachePruning"]), z.boolean().nullable()).optional().describe("Per-behaviour switches overriding the mode's defaults for this machine: true/false, or null to return one to the default. Omit to leave them unchanged."),
			cleanup_now: z.literal(true).optional().describe("Ask this machine to run one cleanup pass now (picked up on its next heartbeat, even if it is idle). Read the result with get_machine_policy."),
			dry_run: z.boolean().optional().describe("Report the saved policy change without changing it."),
		},
		async ({ token, machine_id, auto_update, display_name, cleanup_mode, cleanup_overrides, cleanup_now, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			if (auto_update === undefined && display_name === undefined && cleanup_mode === undefined && cleanup_overrides === undefined && cleanup_now === undefined) return text("Error: give display_name, auto_update, cleanup_mode, cleanup_overrides, cleanup_now, or a combination.");
			const body = {
				...(auto_update !== undefined ? { auto_update } : {}),
				...(display_name !== undefined ? { display_name } : {}),
				...(cleanup_mode !== undefined ? { cleanup_mode } : {}),
				...(cleanup_overrides !== undefined ? { cleanup_overrides } : {}),
				...(cleanup_now !== undefined ? { cleanup_now } : {}),
			};
			const input = { machine_id, ...body };
			const denied = await requirePermission(safetyFor(token), "write", "set_machine_policy", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/machines/${encodeURIComponent(machine_id)}/policy`;
			if (dry_run) {
				const what = [display_name !== undefined ? (display_name.trim() ? `name it "${display_name.trim()}"` : "clear its name") : "", auto_update !== undefined ? `${auto_update ? "enable" : "disable"} Auto-update` : "", cleanup_mode !== undefined ? `set post-run cleanup to ${cleanup_mode}` : "", cleanup_overrides !== undefined ? "change its cleanup switches" : "", cleanup_now ? "run a cleanup pass now" : ""].filter(Boolean).join(" and ");
				return dryRun(safetyFor(token), "set_machine_policy", `${what} for ${machine_id}`, input, { endpoint, method: "PUT", body });
			}
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "set_machine_policy", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	// ── Per-machine admission thresholds (#1275) ─────────────────────────────────
	//
	// The runner admission gate (#1264) refuses a NEW coding session on an overloaded machine. Its lines used to be one
	// formula and a few constants; these are the machine's own, shared by every agent that runs there.
	server.tool(
		"get_machine_thresholds",
		"Read one machine's admission thresholds (#1275): the session limit and the CPU, memory and disk lines the runner admission gate judges it against, where each came from (`machine` = you set it, `default`), the gate's verdict now (`accepting` or `rejecting:<metric>`, with the reading, the line and how many clear samples it has toward reopening), and what every field means. `maxSessions.value` is the limit in force — your override, else the cores/memory formula (`maxSessions.formula`) — and counts every kind of work on the machine (coding sessions, browser, application tailor and apply runs). The same view is on list_runner_nodes (`thresholds`) and coding_loop_status (`runnerGate`). Read-only. Change it with set_machine_thresholds.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from list_runner_nodes; do not use a hostname alias."),
		},
		async ({ token, machine_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_machine_thresholds", { machine_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/terminals/machines/${encodeURIComponent(machine_id)}/thresholds`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"set_machine_thresholds",
		"Change one machine's admission thresholds (#1275) — a PARTIAL update: give only the fields to change; a number sets it, null puts it back to the default, a field you omit is left alone. Fields: maxSessions, cpuLoad1PerCpu, cpuLoad5PerCpu, memUsedPctMax, memAvailableMinBytes, diskUsedPctMax, diskFreeMinBytes, recoveryBand, recoveryStreak. `maxSessions` (1-64) is an explicit session limit that replaces the cores/memory formula (e.g. 2 for a small laptop the formula caps at 1); the rest are the lines at which the gate REJECTS a new session — load per core (1 and 5 minute), memory in use %, available memory bytes, checkout-disk in use % and free bytes (0 turns a byte floor off) — and the recovery rule that REOPENS it: `recoveryBand` (every metric must be under this fraction of its line, default 0.9) held for `recoveryStreak` consecutive ~30s samples (default 2). The setting belongs to the machine, so it applies to every agent that runs there; it takes effect at the machine's next heartbeat and never touches a session already running. Returns the thresholds now in force and the verdict. Call with dry_run first; undo with reset_machine_thresholds.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from list_runner_nodes; do not use a hostname alias."),
			maxSessions: z.coerce.number().int().min(1).max(64).nullable().optional().describe("Reject a new session once this many are running on the machine. null = the cores/memory formula."),
			cpuLoad1PerCpu: z.coerce.number().min(0.1).max(64).nullable().optional().describe("Reject when the 1-minute load per core exceeds this (default 1.5)."),
			cpuLoad5PerCpu: z.coerce.number().min(0.1).max(64).nullable().optional().describe("Reject when the 5-minute load per core exceeds this (default 1.2)."),
			memUsedPctMax: z.coerce.number().min(1).max(100).nullable().optional().describe("Reject when memory in use exceeds this percent (default 92; not judged on macOS until the runner reports available memory)."),
			memAvailableMinBytes: z.coerce.number().int().min(0).nullable().optional().describe("Reject when available memory falls under this many bytes (default 1 GiB). 0 never rejects on it."),
			diskUsedPctMax: z.coerce.number().min(1).max(100).nullable().optional().describe("Reject when the checkout volume in use exceeds this percent (default 95)."),
			diskFreeMinBytes: z.coerce.number().int().min(0).nullable().optional().describe("Reject when the checkout volume has less than this many bytes free (default 10 GiB). 0 never rejects on it."),
			recoveryBand: z.coerce.number().min(0.5).max(0.99).nullable().optional().describe("The gate reopens only when every metric is under this fraction of its reject line (default 0.9)."),
			recoveryStreak: z.coerce.number().int().min(1).max(20).nullable().optional().describe("Consecutive clear samples required before a rejecting gate reopens (default 2)."),
			dry_run: z.boolean().optional().describe("Report the change without saving it."),
		},
		async ({ token, machine_id, dry_run, ...fields }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
			if (!Object.keys(body).length) return text("Error: give at least one threshold to change (maxSessions, cpuLoad1PerCpu, cpuLoad5PerCpu, memUsedPctMax, memAvailableMinBytes, diskUsedPctMax, diskFreeMinBytes, recoveryBand, recoveryStreak).");
			const input = { machine_id, ...body };
			const denied = await requirePermission(safetyFor(token), "write", "set_machine_thresholds", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/machines/${encodeURIComponent(machine_id)}/thresholds`;
			if (dry_run) return dryRun(safetyFor(token), "set_machine_thresholds", `change ${Object.keys(body).join(", ")} for ${machine_id}`, input, { endpoint, method: "PUT", body });
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "set_machine_thresholds", action: "completed", input, result: data });
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);

	server.tool(
		"reset_machine_thresholds",
		"Remove every threshold override on one machine (#1275): it goes back to the defaults and the cores/memory session formula. Returns the thresholds now in force and `before`, the overrides that were removed. Does not touch a session already running. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			machine_id: z.string().describe("Stable physical machine id from list_runner_nodes; do not use a hostname alias."),
			dry_run: z.boolean().optional().describe("Report the reset without doing it."),
		},
		async ({ token, machine_id, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { machine_id };
			const denied = await requirePermission(safetyFor(token), "write", "reset_machine_thresholds", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/machines/${encodeURIComponent(machine_id)}/thresholds`;
			if (dry_run) return dryRun(safetyFor(token), "reset_machine_thresholds", `remove every threshold override for ${machine_id}`, input, { endpoint, method: "DELETE" });
			const data = (await authedCall(endpoint, sessionToken, { method: "DELETE" }, env)) as { error?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "reset_machine_thresholds", action: "completed", input, result: data });
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
		"Force a machine's connected `pags up` to (re)attach ONE agent now — the remote equivalent of `pags up --force`, scoped to this instance. Use it when instance_runner_node shows the machine online (`nodeOnline: true`) but this agent not connected, when coding_diagnostics reports an unresponsive runner with a connected relay (a stale agent socket may recover through this path), when a start fails with \"another runner on it may already hold this agent\", or when set_instance_runner_node's `attachment.detail` names this tool. It clears a stale socket from the agent's relay slot (only one that answers no ping — a live one is taken over by the runner, not killed), then asks the machine's runner, over a socket that answers there, to attach this agent with force. Targets the machine the agent is pinned to unless `runner_node` names another; it does NOT change the pin (set_instance_runner_node does). Answers `{node, attached, transport, health, remedy?, evicted, detail?}`. `attached` and `transport` are the relay TRANSPORT only — this agent's socket is live there (#1032); `health` is the `/health` probe run through that socket right after (`state` ok | timeout | unresponsive | disconnected | failed | not_attempted), and only `health.state: \"ok\"` means the agent can work. Attached with failing health is a wedged runner behind a live socket: attaching again will not fix it, and `remedy` names runner_restart. When `attached` is false, `detail` is the specific reason — e.g. every socket on that machine is frozen, or the machine may not run this agent. When the machine has not confirmed within 15s the relay is asked once more: `{node, attached: true}` if the agent's socket is already live there, else `{attached: false, unconfirmed: true, detail}`. An interrupted or slow confirmation answers `{outcome: unknown, confirmation: {reason, httpStatus?}, possibleOutcomes, poll}`; eviction or attachment may already have happened, so poll instance_runner_node before retrying. Needs a `pags up` running on the machine; it cannot start one. An instance no runner would attach is refused with 409 before any machine is asked, by the runner's own rule, with `cause`: `paused` (`Error: Instance is paused — resume it (resume_instance) to attach.`; its status is not changed), `not_active` (canceled — subscribe again), or `no_runtime` (a cloud-only agent: no `pags up` ever holds it, so there is nothing to attach). When it does not attach, `cause` says why, measured: `no_socket`, `runner_timeout` (with `machineAtLastHeartbeat`, the last load sample — context only), `runner_unresponsive`, `refused`, `stale_registration` (flagged in `stale`, never pruned) or `old_runner`; an unconfirmed answer also carries `phase`, how far the attach got. Attempts and outcomes are recorded in instance_activity (`runner.attach`), failures in list_errors.",
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

	// ── Restart without an update (#1032) ───────────────────────────────────────
	//
	// The recovery for "relay attached, runner not answering": force_runner_attach fixes a stale
	// socket, not a wedged runtime behind a live one. The machine's relay client answers this itself,
	// so it reaches a machine whose `/health` does not — the same durable, single-flight operation as
	// runner_update, polled the same way.
	server.tool(
		"runner_restart",
		"Restart a machine's `pags` runner on the CLI it already has — no install — entirely remotely (#1032). Use it when force_runner_attach answers `transport: \"attached\"` but `health.state` is not `ok`, or when instance_runtime_status / coding_diagnostics show `statusView.relay.attached: true` with `statusView.rpc.health` failing: the relay socket is up but the runner behind it does not answer, and attaching again will not fix that. The machine's relay client answers this command itself, so it reaches a machine whose /health does not. It is guarded like an update: while work runs there it answers `refused` with `waitingFor`, and when the machine cannot show itself idle (its work check did not answer — usually the wedged part itself) it answers `refused` saying so; pass force (with confirm: \"runner_restart\") to restart anyway, which LOSES any run in progress there. A CLI older than this tool answers `unsupported`: restart `pags up` at the machine once. A DURABLE operation, single-flight per machine with runner_update (one of either runs at a time; a second call joins it with `started: false`): answers `{operationId, kind: \"restart\", state, poll}` at once; read the outcome with runner_update_status. After a restart the answer says which agents came back, which were re-attached, and any still `missing`. Pass dry_run to see what the machine would do without restarting it.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			runner_node: z.string().describe("Machine (node) name to restart, from list_runner_nodes or instance_runner_node's `nodes`."),
			force: z.boolean().optional().describe("Restart even while work runs or when the machine cannot show itself idle. Any run in progress there is lost. Requires confirm."),
			confirm: z.string().optional().describe('Must be "runner_restart" when force is true.'),
			dry_run: z.boolean().optional().describe("Report what would be asked of the machine, without contacting it."),
		},
		async ({ token, runner_node, force, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { runner_node, force: force === true };
			// `runtime`: it restarts a machine's runner, like runner_update.
			const denied = await requirePermission(safetyFor(token), "runtime", "runner_restart", input);
			if (denied) return denied;
			const endpoint = `/v1/terminals/nodes/${encodeURIComponent(runner_node)}/restart`;
			if (dry_run) {
				return dryRun(safetyFor(token), "runner_restart", `restart the runner on ${runner_node}`, input, {
					endpoint,
					method: "POST",
					effect: force
						? `${runner_node} would restart its runner now, even if work is running there (that work is lost), and every agent it holds would be checked back in.`
						: `${runner_node} would restart its runner if it can show itself idle, and every agent it holds would be checked back in; otherwise it refuses and says why.`,
				});
			}
			if (force) {
				const unconfirmed = await requireConfirmation(safetyFor(token), "runner_restart", confirm, "runner_restart", input);
				if (unconfirmed) return unconfirmed;
			}
			const data = (await authedAsyncCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify({ force: force === true }) }, env, { tool: "runner_restart", possibleOutcomes: ["running", "restarting", "restarted", "refused", "unsupported", "unreachable", "failed"], poll: { tool: "runner_update_status", input: { runner_node } } })) as { error?: string; outcome?: string; state?: string };
			if (!data.error) await audit(safetyFor(token), { tool: "runner_restart", action: data.outcome === "unknown" ? "unconfirmed" : "completed", input, result: { state: data.state } });
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

	// ── The GitHub Actions runner on an agent's pinned machine (#1208, #1209) ─────
	server.tool(
		"actions_runner_setup",
		"Install (or remove) the GitHub Actions self-hosted runner as a service on the machine one coding agent is pinned to (#1113). The platform mints the runner registration (or removal) token through the ProAgentStore GitHub App and hands it straight to that machine's `pags up` — it is never stored or returned. The runner is named `pags-<node>` and labelled `pags`, `pags-<node>` and the machine's CAPABILITIES (#1260): `has-<tool>` for each of brew, jq, flutter, dart, docker, python3, go, node, pnpm, aws, git and xcode found on it, and `macos-NN+` for every macOS tier it meets — so a workflow can require `has-jq` or `macos-14+` and a machine without it never takes the job. The answer carries `preflight` (before the runner takes jobs: which CI tools — brew, jq, flutter, dart — the machine lacks, how to install each, and an OS warning such as macOS older than 14 for Flutter; informational, it does not block) and `capabilities`. Asking again for a runner that is already registered REFRESHES its capability labels at GitHub (`refreshed`) instead of reinstalling — do it after installing a tool or upgrading the OS. `scope` is `{org}` (an org that owns one of this agent's repos) or `{repo}` (one of its repos — private only; a public repo is refused). Answers at once with the machine's job (`state` running/done/failed, `steps`, `prerequisites` such as a missing AWS CLI, `service`, and `serviceNote` when a step needs an administrator on the machine); read it with actions_runner_status. Refused with the permission to grant until the App's runner permissions are accepted on that org (#1207). `runtime`: it installs software and a service on the owner's machine. Call with dry_run first.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID of the coding agent whose pinned machine gets the runner, from my_instances."),
			action: z.enum(["install", "remove"]).describe("install: register and start the runner service. remove: stop, uninstall and deregister it."),
			scope: z.object({ org: z.string().optional(), repo: z.string().optional() }).strict().describe('Exactly one of { "org": "<org>" } or { "repo": "<owner>/<name>" }.'),
			runner_group: z.string().optional().describe("Org scope only: the runner group to join (needs GitHub Team for anything but Default)."),
			dry_run: z.boolean().optional().describe("Report what would be asked of the machine, without minting a token or contacting it."),
		},
		async ({ token, instance_id, action, scope, runner_group, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, action, scope, runner_group };
			// `runtime`: it installs software and a service on the owner's machine.
			const denied = await requirePermission(safetyFor(token), "runtime", "actions_runner_setup", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${encodeURIComponent(instance_id)}/actions-runner`;
			const body = { action, scope, ...(runner_group ? { runnerGroup: runner_group } : {}) };
			if (dry_run) return dryRun(safetyFor(token), "actions_runner_setup", `${action} the GitHub Actions runner on this agent's pinned machine`, input, { endpoint, method: "POST", body });
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify(body) }, env)) as { error?: string; job?: { id?: string; state?: string } };
			if (data.error) return text(`Error: ${data.error}`);
			await audit(safetyFor(token), { tool: "actions_runner_setup", action: "completed", input, result: { jobId: data.job?.id, state: data.job?.state } });
			return jsonText(data);
		},
	);

	server.tool(
		"actions_runner_status",
		"Read the GitHub Actions runners configured on one coding agent's pinned machine — the platform's own and any hand install (`managed: false`), each with its name and GitHub URL — and, with job_id, the progress of an actions_runner_setup job. Read-only.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID of the coding agent, from my_instances."),
			job_id: z.string().optional().describe("The `job.id` actions_runner_setup answered with."),
		},
		async ({ token, instance_id, job_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "actions_runner_status", { instance_id, job_id });
			if (denied) return denied;
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/actions-runner${job_id ? `?jobId=${encodeURIComponent(job_id)}` : ""}`, sessionToken, {}, env)) as { error?: string };
			return data.error ? text(`Error: ${data.error}`) : jsonText(data);
		},
	);
}
