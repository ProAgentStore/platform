import { RunnerInputError } from "../errors.js";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { LocalApplyPause, LocalApplyStatusResponse, LocalApplyTaskEnvelope } from "./contract.js";

interface OwnerPauseRun {
	envelope: Pick<LocalApplyTaskEnvelope, "runId" | "applicationId" | "browserProfile">;
	state: "running" | "paused" | "ended";
	pause?: LocalApplyPause;
	cancelled: boolean;
	timedOut: boolean;
	ownerPauseReady?: boolean;
	browser?: { tools: BrowserTools };
}

/** Fence dispatch before awaiting actual native settlement. This does not stop background site/code effects. */
export async function requestOwnerPause(run: OwnerPauseRun, raw: unknown, pause: () => void, status: () => LocalApplyStatusResponse): Promise<LocalApplyStatusResponse> {
	const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	if (o.runId !== run.envelope.runId || o.applicationId !== run.envelope.applicationId || o.browserProfile !== run.envelope.browserProfile) throw new RunnerInputError("Owner pause does not match this exact application run/profile", 403);
	if (run.state === "ended" || run.cancelled || run.timedOut || run.state === "paused" && run.pause?.reason !== "owner_requested") throw new RunnerInputError("Only a running application or its existing owner pause can be taken over", 409);
	const tools = run.browser?.tools;
	if (!tools?.suspendDispatch || !tools.resumeDispatch) throw new RunnerInputError("This browser cannot safely pause native dispatch for owner control", 409);
	run.ownerPauseReady = false;
	const settling = tools.suspendDispatch(); // The native fence is synchronous, before the first await.
	pause();
	const receipt = await settling;
	if ((run.state as OwnerPauseRun["state"]) === "ended" || run.cancelled || run.timedOut) throw new RunnerInputError("The application stopped while owner control was being prepared", 409);
	if (receipt.state !== "settled") throw new RunnerInputError(`AI browser dispatch is paused, but native execution is ${receipt.state}. Owner control is unavailable; wait and retry, or Stop.`, 409);
	run.ownerPauseReady = true;
	return status();
}
