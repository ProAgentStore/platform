/** An owner website answer may release its exact retained pause, never create a new attempt. */
import type { Env } from "../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../routes/instances-runtime.js";
import { readBrowserSettings } from "./browser-settings.js";
import { isCurrentGenericWebsiteRequest, resumeGenericWebsiteRequest } from "./browser-website-access.js";
import { resumeNativeWebsiteWaiters } from "./browser-website-native.js";
import { getOwnedApplication } from "./local-artifact/store.js";
import { getApplyRun } from "./local-apply/store.js";
import { resumeApplyRun } from "./local-apply/apply.js";
import { getLocalBrowserRun } from "./local-browser/store.js";
import { resumeLocalBrowserRun } from "./local-browser/sync.js";
import { LOCAL_BROWSER_STATUS_PATH } from "./local-browser/contract.js";
import { applyWebsitePause, parseWebsitePause } from "./website-access-local.js";
import type { WebsiteAccessAnswerAdapters, WebsiteAccessRequest } from "./website-access.js";

export function websiteAccessResumeAdapters(env: Env, uid: string, instanceId: string): WebsiteAccessAnswerAdapters {
	const bound = (request: WebsiteAccessRequest) => request.instanceId === instanceId;
	const applyRun = async (request: WebsiteAccessRequest) => {
		if (!bound(request)) return null;
		const run = await getApplyRun(env, instanceId, uid, request.subjectId);
		const pause = run && applyWebsitePause(run);
		if (!run || !pause || pause.hostname !== request.hostname || pause.pauseKey !== request.pauseKey || run.policy.browserWebsiteAccess?.mode !== "ask_once") return null;
		const application = await getOwnedApplication(env, uid, run.applicationId);
		return application?.fillRunId === run.id ? run : null;
	};
	const researchRun = async (request: WebsiteAccessRequest) => {
		if (!bound(request)) return null;
		const run = await getLocalBrowserRun(env, instanceId, uid, request.subjectId);
		if (run?.status !== "paused" || run.pauseReason !== "consent_required" || run.policy.browserWebsiteAccess?.mode !== "ask_once") return null;
		const runtime = await getLiveRuntime(env, instanceId, uid).catch(() => null);
		if (!runtime) return null;
		const response = await callRuntime(env, runtime, LOCAL_BROWSER_STATUS_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, afterSeq: run.runnerSeq }) }).catch(() => null);
		if (!response?.ok) return null;
		const status = await runtimeJson(response).catch(() => null) as { state?: unknown; websitePause?: unknown } | null;
		const pause = parseWebsitePause(status?.websitePause);
		return status?.state === "paused" && pause?.hostname === request.hostname && pause.pauseKey === request.pauseKey ? run : null;
	};
	return {
		canAnswer: async (request) => bound(request) && (await readBrowserSettings(env, instanceId, uid)).effective.websiteAccess?.mode === "ask_once",
		afterDecision: (request) => resumeNativeWebsiteWaiters(env, uid, request, { ...(request.subjectKind === "runtime_task" ? { excludeTaskId: request.subjectId } : {}) }),
		isCurrent: async (request) => {
			if (request.subjectKind === "local_apply_run") return !!await applyRun(request);
			if (request.subjectKind === "local_browser_run") return !!await researchRun(request);
			if (bound(request) && request.subjectKind === "runtime_task") return isCurrentGenericWebsiteRequest(env, uid, request);
			return false;
		},
		resume: async (request) => {
			const websiteDecision = request.status === "denied" ? "deny" : "allow";
			if (request.subjectKind === "local_apply_run") {
				const run = await applyRun(request);
				if (!run) return { resumed: false, reason: "Permission saved. The original application is no longer waiting at this website." };
				const current = await resumeApplyRun(env, uid, run, { expectedWebsitePauseKey: request.pauseKey, websiteDecision });
				return { resumed: websiteDecision === "allow" && current.status === "running", ...(current.status !== "running" ? { reason: `Decision saved. The application is ${current.status}; check its current status before continuing.` } : {}) };
			}
			if (request.subjectKind === "local_browser_run") {
				const run = await researchRun(request);
				if (!run) return { resumed: false, reason: "Permission saved. The original research run is no longer waiting at this website." };
				const current = await resumeLocalBrowserRun(env, instanceId, uid, run, Date.now(), { expectedWebsitePauseKey: request.pauseKey, websiteDecision });
				return { resumed: websiteDecision === "allow" && current.status === "running", ...(current.status !== "running" ? { reason: `Decision saved. The research run is ${current.status}.` } : {}) };
			}
			if (bound(request) && request.subjectKind === "runtime_task") return resumeGenericWebsiteRequest(env, uid, request);
			return { resumed: false, reason: "Permission saved for this agent's next browser action." };
		},
	};
}
