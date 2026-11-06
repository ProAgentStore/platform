/** Effective Runner configuration shared by dispatch and scoped approval, without importing either. */
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { readInstanceConfigPair } from "../instance-config.js";
import { type ApplicationRunnerSettings, RUNNER_SETTINGS_KEY, effectiveRunnerSettings } from "./policy.js";

/** The Runner's effective settings, or why they cannot be used. */
export async function runnerSettingsFor(env: Env, runnerInstanceId: string, uid: string): Promise<ApplicationRunnerSettings> {
	const pair = await readInstanceConfigPair(env, runnerInstanceId, uid);
	const settings = effectiveRunnerSettings((pair?.config as Record<string, unknown> | undefined)?.[RUNNER_SETTINGS_KEY]);
	if ("error" in settings) throw new HttpError(409, `The Application Runner settings are invalid: ${settings.error}`);
	return settings.settings;
}
