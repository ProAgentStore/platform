/**
 * The cloud half of `native_preflight` (#1057, slice 1): ask the instance's live runner what native
 * desktop / Maestro control could do on ITS machine — only once the owner has opted that machine in.
 *
 * Every refusal is a stable code with a sentence, never a silent wait (the issue's observability
 * rule): no runner, a runner that cannot name its machine, a machine not opted in, a runner too old
 * to answer, a runner that dropped mid-call. Nothing here drives a screen or a device.
 */
import type { Env } from "../../types.js";
import { logEvent } from "../events.js";
import { callRuntime, getLiveRuntime } from "../../routes/instances-runtime.js";
import { NATIVE_PREFLIGHT_CAPABILITY, NATIVE_PREFLIGHT_PATH, type NativeErrorCode, type NativePreflightResult } from "./contract.js";
import { getNativeOptIn, nativeAnyEnabled, nativeBackendEnabled, NATIVE_RISK_DISCLOSURE_V1 } from "./policy.js";

export type NativePreflightOutcome =
	| { status: 200; body: { machineId: string; node: string; enabled: { desktop: boolean; maestro: boolean }; preflight: NativePreflightResult } }
	| { status: 403 | 409 | 503; body: { code: NativeErrorCode; error: string; machineId?: string; disclosureVersion?: string } };

const refuse = (status: 403 | 409 | 503, code: NativeErrorCode, error: string, extra: Record<string, string> = {}): NativePreflightOutcome => ({ status, body: { code, error, ...extra } });

export async function nativePreflight(env: Env, instanceId: string, userId: string): Promise<NativePreflightOutcome> {
	const runtime = await getLiveRuntime(env, instanceId, userId);
	if (!runtime) return refuse(409, "NATIVE_RUNNER_UNREACHABLE", "No runner is connected for this agent. Start `pags up` on the machine you want to check.");
	const machineId = runtime.machine_id ?? null;
	if (!machineId) return refuse(409, "NATIVE_RUNNER_UNSUPPORTED", `The runner on ${runtime.runner_node} does not report a stable machine id, so its native-control opt-in cannot be checked. Update the CLI (npm i -g @proagentstore/cli) and run \`pags up\` again.`);

	const optIn = await getNativeOptIn(env, userId, machineId);
	if (!optIn || !nativeAnyEnabled(optIn)) {
		const stale = optIn && (optIn.desktop || optIn.maestro) && !optIn.disclosureCurrent;
		return refuse(
			403,
			"NATIVE_NOT_ENABLED",
			stale
				? `Native control on ${runtime.runner_node} was enabled under an older risk disclosure; the owner must review and acknowledge the current one (${NATIVE_RISK_DISCLOSURE_V1.version}) before it counts again.`
				: `Native desktop / Maestro control is off for ${runtime.runner_node}. Only the owner can turn it on, per machine, after reading the account-risk disclosure (POST /v1/terminals/machines/${machineId}/native-optin).`,
			{ machineId, disclosureVersion: NATIVE_RISK_DISCLOSURE_V1.version },
		);
	}

	let advertised: string[] = [];
	try {
		advertised = JSON.parse(runtime.capabilities || "[]") as string[];
	} catch {
		advertised = [];
	}
	if (!advertised.includes(NATIVE_PREFLIGHT_CAPABILITY)) {
		return refuse(409, "NATIVE_RUNNER_UNSUPPORTED", `The runner on ${runtime.runner_node} (CLI ${runtime.runner_version || "unknown"}) cannot run the native preflight. Update the CLI (npm i -g @proagentstore/cli) and run \`pags up\` again.`, { machineId });
	}

	let res: Response;
	try {
		res = await callRuntime(env, runtime, NATIVE_PREFLIGHT_PATH, { method: "POST", body: "{}" });
	} catch {
		return refuse(503, "NATIVE_RUNNER_UNREACHABLE", `The runner on ${runtime.runner_node} could not be reached. Check \`pags up\` on that machine.`, { machineId });
	}
	if (res.status === 404) return refuse(409, "NATIVE_RUNNER_UNSUPPORTED", `The runner on ${runtime.runner_node} does not know the native preflight. Update the CLI and run \`pags up\` again.`, { machineId });
	if (!res.ok) return refuse(503, "NATIVE_RUNNER_UNREACHABLE", `The runner on ${runtime.runner_node} did not answer the native preflight (HTTP ${res.status}).`, { machineId });
	const preflight = (await res.json()) as NativePreflightResult;

	const enabled = { desktop: nativeBackendEnabled(optIn, "desktop"), maestro: nativeBackendEnabled(optIn, "maestro") };
	// Audit: which machine was probed and what it reported — codes and states only.
	await logEvent(env, {
		source: "tool",
		event: "native.preflight",
		message: `native preflight on ${runtime.runner_node}: ${preflight.errors.length ? preflight.errors.map((e) => e.code).join(", ") : "nothing missing"}`,
		userId,
		instanceId,
		level: "info",
		context: { machineId, node: runtime.runner_node, enabled, desktopPermission: preflight.desktop?.permissionState ?? null, maestroInstalled: preflight.maestro?.installed ?? null, devices: preflight.maestro?.connectedDevices?.length ?? 0, errors: preflight.errors?.map((e) => e.code) ?? [] },
	}).catch(() => undefined);
	return { status: 200, body: { machineId, node: runtime.runner_node, enabled, preflight } };
}
