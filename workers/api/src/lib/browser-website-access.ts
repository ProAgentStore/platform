import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "../types.js";
import type { ApplyResult } from "./apply-loop.js";
import { browserRunPark, handoffGiveUpAt } from "./browser-run.js";
import { deepLinkFor } from "./console-links.js";
import { ensureWebsiteAccessRequest, getWebsiteAccessRequest, listRememberedWebsiteDomains, type WebsiteAccessRequest } from "./website-access.js";

import { browserWebsiteBlock, clearWebsiteWait, isCurrentGenericWebsiteRequest, markWebsiteWait, type BrowserWebsiteBlock, type TaskKey } from "./browser-website-state.js";
export { browserWebsiteBlock, clearWebsiteWait, isCurrentGenericWebsiteRequest, markWebsiteWait, type BrowserWebsiteBlock, type BrowserWebsiteReply } from "./browser-website-state.js";

export class BrowserWebsiteAccessRequired extends Error {
	constructor(readonly access: BrowserWebsiteBlock) {
		super(`Website access ${access.decision === "ask" ? "needs owner approval" : "is denied"}: ${access.hostname}`);
		this.name = "BrowserWebsiteAccessRequired";
	}
}

/** Call AFTER a durable action step returns, never inside its at-most-once dispatch callback. */
export function requireBrowserWebsiteAccess<T>(receipt: T): T {
	const access = browserWebsiteBlock(receipt);
	if (access) throw new BrowserWebsiteAccessRequired(access);
	return receipt;
}

/** Permission answers wake no new workflow and dispatch no stored action; the existing wait polls. */
export async function resumeGenericWebsiteRequest(env: Env, userId: string, request: WebsiteAccessRequest): Promise<{ resumed: boolean; reason: string }> {
	const current = await isCurrentGenericWebsiteRequest(env, userId, request);
	if (current) {
		const task = await env.DB.prepare("SELECT type FROM instance_runtime_tasks WHERE id=?1 AND instance_id=?2 AND user_id=?3").bind(request.subjectId, request.instanceId, userId).first<{ type: string }>();
		if (task?.type === "browser.open") {
			const { resumeNativeWebsiteRequest } = await import("./browser-website-native.js");
			return resumeNativeWebsiteRequest(env, userId, request);
		}
	}
	return { resumed: current, reason: current ? "Permission saved; the existing waiting task will continue from a fresh snapshot." : "The original task is no longer waiting on this question. No browser action was dispatched." };
}

export type BrowserWebsiteWaitResult = { approved: true; questionUrl: string } | { approved: false; result: ApplyResult; questionUrl?: string };
export interface BrowserWebsiteWaitDeps {
	create(): Promise<WebsiteAccessRequest>;
	read(id: string): Promise<WebsiteAccessRequest | null>;
	isCurrent(request: WebsiteAccessRequest): Promise<boolean>;
	granted(hostname: string): Promise<boolean>;
	park(pollsRemaining: number): Promise<boolean>;
	sleep(poll: number): Promise<void>;
}

/** Shared by both browser workflows. Approval is permission to reconsider, never replay a click. */
export async function waitForWebsiteDecision(access: BrowserWebsiteBlock, deps: BrowserWebsiteWaitDeps, polls = 180): Promise<BrowserWebsiteWaitResult> {
	if (access.decision === "deny") return { approved: false, result: { outcome: "blocked", detail: `Website access denied by this agent's settings: ${access.hostname}.`, steps: 0 } };
	const request = await deps.create();
	for (let poll = 0; poll < polls; poll++) {
		if (await deps.park(polls - poll)) return { approved: false, questionUrl: request.questionUrl, result: { outcome: "cancelled", detail: "Stopped by the owner while waiting for website permission.", steps: 0 } };
		if (!(await deps.isCurrent(request))) return { approved: false, questionUrl: request.questionUrl, result: { outcome: "cancelled", detail: "The original website-permission pause is no longer current; no action was repeated.", steps: 0 } };
		const answer = await deps.read(request.id);
		if (!answer || answer.status === "denied") return { approved: false, questionUrl: request.questionUrl, result: { outcome: "blocked", detail: `Website permission was denied or is no longer available: ${access.hostname}.`, steps: 0 } };
		if (answer.status === "approved") {
			if (await deps.granted(access.hostname)) return { approved: true, questionUrl: request.questionUrl };
			return { approved: false, questionUrl: request.questionUrl, result: { outcome: "blocked", detail: `Website permission is no longer granted for ${access.hostname}.`, steps: 0 } };
		}
		await deps.sleep(poll);
	}
	return { approved: false, questionUrl: request.questionUrl, result: { outcome: "needs_input", detail: `Website permission is still pending: ${request.questionUrl}`, fieldNeeded: `Website permission for ${access.hostname}`, steps: 0 } };
}

/** Every DB read/sleep is durable; nothing nests workflow steps inside a step.do callback. */
export async function waitForBrowserWebsiteAccess(env: Env, step: WorkflowStep, key: TaskKey & { loopRunId: string | null; pauseKey: string }, access: BrowserWebsiteBlock): Promise<BrowserWebsiteWaitResult> {
	let poll = 0;
	let request: WebsiteAccessRequest | undefined;
	const result = await waitForWebsiteDecision(access, {
		create: async () => {
			request = await step.do(`${key.pauseKey}-request`, async () => {
				const created = await ensureWebsiteAccessRequest(env, { ...key, subjectKind: "runtime_task", subjectId: key.taskId, hostname: access.hostname, subjectLink: deepLinkFor({ kind: "task", instanceId: key.instanceId, taskId: key.taskId }) });
				await markWebsiteWait(env, key, created);
				return created;
			});
			return request;
		},
		read: (id) => step.do(`${key.pauseKey}-read-${poll}`, () => getWebsiteAccessRequest(env, key.userId, key.instanceId, id)),
		// A shared host question keeps its first originating subject. This workflow still binds
		// its own current pause to that question, without changing the question's recorded origin.
		isCurrent: (r) => step.do(`${key.pauseKey}-current-${poll}`, () => isCurrentGenericWebsiteRequest(env, key.userId, { ...r, subjectKind: "runtime_task", subjectId: key.taskId, pauseKey: key.pauseKey })),
		granted: (hostname) => step.do(`${key.pauseKey}-grant-${poll}`, async () => (await listRememberedWebsiteDomains(env, key.userId, key.instanceId)).includes(hostname)),
		park: (remaining) => step.do(`${key.pauseKey}-park-${poll}`, () => browserRunPark(env, key.loopRunId, handoffGiveUpAt(Date.now(), remaining))),
		sleep: async (index) => { await step.sleep(`${key.pauseKey}-wait-${index}`, "5 seconds"); poll++; },
	});
	if (request) await step.do(`${key.pauseKey}-clear`, async () => { await clearWebsiteWait(env, key, request!); return true; });
	return result;
}

/** The opening navigation is also subject to permission. Approval only reads a fresh snapshot;
 * it never repeats navigation, including when a redirect followed an already-dispatched action. */
export async function resolveOpeningWebsiteAccess<T>(initial: T, wait: (access: BrowserWebsiteBlock, round: number) => Promise<BrowserWebsiteWaitResult>, snapshot: (round: number) => Promise<T>): Promise<{ receipt: T; stop?: ApplyResult }> {
	let receipt = initial;
	for (let round = 0; round < 12; round++) {
		const access = browserWebsiteBlock(receipt);
		if (!access) return { receipt };
		const answer = await wait(access, round);
		if (!answer.approved) return { receipt, stop: answer.result };
		receipt = await snapshot(round);
	}
	return { receipt, stop: { outcome: "blocked", detail: "Too many website permission changes while opening this task; no action was repeated.", steps: 0 } };
}
