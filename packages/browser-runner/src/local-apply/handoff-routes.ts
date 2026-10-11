import type { LocalApplyRuntime } from "./runtime.js";

/**
 * The local-apply takeover surface is separate from generic task takeover: every request carries
 * the exact run/application/profile binding that the runtime verifies before it reaches a page.
 */
export async function routeLocalApplyHandoff(
	runtime: LocalApplyRuntime,
	method: string | undefined,
	path: string,
	read: () => Promise<unknown>,
): Promise<unknown | undefined> {
	if (method !== "POST") return undefined;
	if (path === "/local-apply/handoff") return runtime.handoff(await read());
	if (path === "/local-apply/handoff-status") return runtime.handoffStatus(await read());
	if (path === "/local-apply/handoff/frame") return runtime.handoffFrame(await read());
	if (path === "/local-apply/handoff/input") {
		await runtime.handoffInput(await read());
		return { ok: true };
	}
	if (path === "/local-apply/handoff/end" || path === "/local-apply/handoff/resume") return runtime.endHandoff(await read());
	return undefined;
}
