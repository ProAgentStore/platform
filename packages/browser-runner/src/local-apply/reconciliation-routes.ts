import type { BrowserWebsiteAccess } from "../browser-website-access.js";
import type { LocalApplyReconciliationRuntime } from "./reconciliation-runtime.js";

/** Separate from apply and generic tasks: this surface has no bridge/fill/submit operation. */
export async function routeLocalApplyReconciliation(runtime: LocalApplyReconciliationRuntime, method: string | undefined, path: string, read: () => Promise<unknown>, policy?: (body: unknown) => BrowserWebsiteAccess | undefined): Promise<unknown | undefined> {
	if (method !== "POST") return undefined;
	if (path === "/local-apply/reconciliation/run") { const body = await read(); return runtime.start(body, policy?.(body)); }
	if (path === "/local-apply/reconciliation/status") return runtime.status(await read());
	if (path === "/local-apply/reconciliation/handoff") return runtime.handoff(await read());
	if (path === "/local-apply/reconciliation/handoff-status") return runtime.status(await read());
	if (path === "/local-apply/reconciliation/handoff/frame") return runtime.handoffFrame(await read());
	if (path === "/local-apply/reconciliation/handoff/input") { return await runtime.handoffInput(await read()) ?? { ok: true }; }
	if (path === "/local-apply/reconciliation/handoff/resume") return runtime.resume(await read());
	if (path === "/local-apply/reconciliation/handoff/end") return runtime.end(await read());
	return undefined;
}
