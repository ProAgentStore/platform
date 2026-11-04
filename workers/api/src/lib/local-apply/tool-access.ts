import { cliAtLeast } from "../runner-upgrade.js";
import { LOCAL_APPLY_FULL_TOOLS_REVISION, type LocalApplyToolAccess, type LocalApplyToolAccessAcceptance } from "./contract.js";
import type { ApplicationRunnerSettings } from "./policy.js";

export const LOCAL_APPLY_FULL_TOOLS_MIN_CLI = "0.4.221";
export const TOOL_ACCESS_DISCLOSURE = {
	revision: LOCAL_APPLY_FULL_TOOLS_REVISION,
	title: "Full Playwright tools — explicit risk acceptance",
	risks: [
		"The model can use the complete upstream Playwright tool set, including arbitrary browser code and unsafe code execution. Unsafe code is not sandboxed: it can access this machine's files, network and processes with the runner's permissions.",
		"Tools can submit forms, change or delete data, upload files and disclose information through signed-in sessions. Fill-only and read-only instructions are not reliably enforced for arbitrary code.",
		"Arbitrary code can bypass domain restrictions, screenshot masking, credential-origin controls and supervised submission checks. Screenshots and action logs may not capture every effect.",
		"Accepting these risks does not authorize intentional application submission. Auto-submit and per-application submission approval remain separate permissions.",
		"Review the browser accounts and documents accessible to the runner before enabling full tools. You can disable full access in this instance at any time.",
		"Queued full-access runs cannot start after disabling or renewing acceptance; cancel and requeue them under the current settings. Active runs keep their frozen policy until stopped. Stop cannot undo completed effects or reliably interrupt already-running arbitrary code; a hung runner may need restarting.",
	],
};

type AccessPolicy = { toolAccess?: LocalApplyToolAccess; toolAccessAcceptance?: LocalApplyToolAccessAcceptance | null };
export function parseToolAccessAcceptance(value: unknown): LocalApplyToolAccessAcceptance | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const a = value as Record<string, unknown>;
	if (a.revision !== LOCAL_APPLY_FULL_TOOLS_REVISION || typeof a.acceptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(a.acceptedAt) || !Number.isFinite(Date.parse(a.acceptedAt))) return null;
	if (typeof a.acceptedBy !== "string" || !a.acceptedBy.trim() || a.acceptedBy.length > 200 || typeof a.instanceId !== "string" || !a.instanceId.trim() || a.instanceId.length > 200) return null;
	return { revision: LOCAL_APPLY_FULL_TOOLS_REVISION, acceptedAt: a.acceptedAt, acceptedBy: a.acceptedBy, instanceId: a.instanceId };
}

export function acknowledgeFullBrowserTools(current: ApplicationRunnerSettings, next: ApplicationRunnerSettings, acknowledgement: unknown, owner: { uid: string; instanceId: string }, nowIso: string): { settings: ApplicationRunnerSettings } | { error: string } {
	if (acknowledgement !== undefined && acknowledgement !== LOCAL_APPLY_FULL_TOOLS_REVISION) return { error: `acknowledgeFullBrowserTools must equal ${LOCAL_APPLY_FULL_TOOLS_REVISION}` };
	if (next.toolAccess !== "full") return { settings: { ...next, toolAccessAcceptance: null } };
	const receipt = parseToolAccessAcceptance(current.toolAccessAcceptance);
	if (acknowledgement === LOCAL_APPLY_FULL_TOOLS_REVISION) return { settings: { ...next, toolAccessAcceptance: { revision: LOCAL_APPLY_FULL_TOOLS_REVISION, acceptedAt: nowIso, acceptedBy: owner.uid, instanceId: owner.instanceId } } };
	if (current.toolAccess === "full" && receipt?.acceptedBy === owner.uid && receipt.instanceId === owner.instanceId) return { settings: { ...next, toolAccessAcceptance: receipt } };
	return { error: `Full browser tools require explicit acknowledgement of ${LOCAL_APPLY_FULL_TOOLS_REVISION} in acknowledgeFullBrowserTools. Review the toolAccessDisclosure risks first.` };
}

export function toolAccessRunnerProblem(policy: AccessPolicy, version: string | null | undefined, owner: { uid: string; instanceId: string }): string | null {
	if (policy.toolAccess !== "full") return null;
	const receipt = parseToolAccessAcceptance(policy.toolAccessAcceptance);
	if (!receipt || receipt.acceptedBy !== owner.uid || receipt.instanceId !== owner.instanceId) return "Full browser tools require current risk acceptance recorded for this owner and instance. Review and accept the full-tool disclosure in Application Runner settings.";
	if (!version || !cliAtLeast(version, LOCAL_APPLY_FULL_TOOLS_MIN_CLI)) return `Full browser tools require CLI ${LOCAL_APPLY_FULL_TOOLS_MIN_CLI} or newer; this runner reports ${version || "unknown"}. Update and restart it; older runners cannot honor this policy.`;
	return null;
}

export function queuedToolAccessProblem(frozen: AccessPolicy, current: AccessPolicy): string | null {
	if (frozen.toolAccess !== "full") return null;
	const a = parseToolAccessAcceptance(frozen.toolAccessAcceptance);
	const b = parseToolAccessAcceptance(current.toolAccessAcceptance);
	if (current.toolAccess === "full" && a && b && a.revision === b.revision && a.acceptedAt === b.acceptedAt && a.acceptedBy === b.acceptedBy && a.instanceId === b.instanceId) return null;
	return "Full browser tool acceptance was revoked or replaced after this run was queued. Cancel this queued run and start a new one under the current settings.";
}
