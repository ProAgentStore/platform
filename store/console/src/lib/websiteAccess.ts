import { api } from "@proagentstore/sdk/client";

export type WebsiteAccessMode = "allow_all" | "allowlist" | "ask_once";
export interface WebsiteAccessSettings { mode: WebsiteAccessMode; domains: string[] }
export const WEBSITE_ACCESS_LABELS: Record<WebsiteAccessMode, string> = {
	allow_all: "Allow all websites",
	allowlist: "Only listed websites",
	ask_once: "Ask once for each new website",
};
export function websiteAccessLabel(value: WebsiteAccessSettings | null | undefined): string {
	return value ? WEBSITE_ACCESS_LABELS[value.mode] : "Workflow default";
}

/** Hostnames only: a URL, wildcard or port must never look like a broader saved permission. */
export function parseWebsiteDomains(text: string): string[] {
	const domains = text.split(/[\s,]+/).filter(Boolean).map((value) => {
		if (/[/:?#@*\\]/.test(value)) throw new Error("Enter exact hostnames only, without a URL, port, path or wildcard.");
		let hostname: string;
		try { hostname = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, ""); }
		catch { throw new Error(`Check the website hostname: ${value}`); }
		if (!hostname || !/^[a-z0-9.-]+$/.test(hostname) || hostname.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))) throw new Error(`Check the website hostname: ${value}`);
		return hostname;
	});
	const unique = [...new Set(domains)];
	if (unique.length > 100) throw new Error("List no more than 100 websites.");
	return unique;
}

export interface WebsiteAccessRequest {
	id: string;
	instanceId: string;
	instanceName: string;
	hostname: string;
	subjectKind: string;
	subjectId: string;
	subjectLink?: string | null;
	status: "pending" | "approved" | "denied";
	createdAt: string;
	decidedAt: string | null;
	link: string;
}
export interface WebsiteRequestResponse { request: WebsiteAccessRequest; current?: boolean }
export interface WebsiteAnswerResponse extends WebsiteRequestResponse {
	recorded: true;
	resumed: boolean;
	repeated?: boolean;
	resumeError?: string;
	additionalWaitingTasks?: { continued: number; denied: number; failed: number };
	additionalWaitingTasksError?: string;
}
const instancePath = (id: string) => `/v1/instances/${encodeURIComponent(id)}`;
export const getWebsiteRequest = (instanceId: string, requestId: string) => api<WebsiteRequestResponse>(`${instancePath(instanceId)}/website-requests/${encodeURIComponent(requestId)}`);
export const answerWebsiteRequest = (instanceId: string, requestId: string, decision: "approve" | "deny") => api<WebsiteAnswerResponse>(`${instancePath(instanceId)}/website-requests/${encodeURIComponent(requestId)}/answer`, { method: "POST", body: JSON.stringify({ decision }) });
export const getWebsiteGrants = (instanceId: string) => api<{ domains: string[]; decisions?: Array<{ hostname: string; decision: "allow" | "deny" }> }>(`${instancePath(instanceId)}/website-grants`);
export const revokeWebsiteGrant = (instanceId: string, hostname: string) => api(`${instancePath(instanceId)}/website-grants/${encodeURIComponent(hostname)}`, { method: "DELETE" });

/** Keep the originating run inside the existing console router and its instance scope. */
export function websiteSubjectPath(link: string | null | undefined): string | null {
	if (!link) return null;
	try {
		const url = new URL(link, "https://console.proagentstore.online");
		if (url.origin !== "https://console.proagentstore.online" || url.username || url.password) return null;
		const path = url.pathname.replace(/^\/console(?=\/)/, "");
		return path.startsWith("/instances/") ? `${path}${url.search}${url.hash}` : null;
	} catch { return null; }
}

export function websiteAnswerMessage(answer: WebsiteAnswerResponse): string {
	if (answer.repeated) return `This request was already answered. No run was resumed.${answer.resumeError ? ` ${answer.resumeError}` : ""}`;
	const main = answer.request.status === "denied" ? "Access denied and remembered. This request will not resume the run."
		: answer.resumed ? "Website remembered. The run has resumed."
			: `Website remembered. The run has not resumed.${answer.resumeError ? ` ${answer.resumeError}` : " Open the run to check its current status."}`;
	const counts = answer.additionalWaitingTasks;
	const outcomes = counts ? [counts.continued > 0 && `${counts.continued} continued`, counts.denied > 0 && `${counts.denied} denied`, counts.failed > 0 && `${counts.failed} could not be updated`].filter(Boolean) : [];
	return `${main}${outcomes.length ? ` Other waiting tasks: ${outcomes.join(", ")}.` : ""}${answer.additionalWaitingTasksError ? ` ${answer.additionalWaitingTasksError}` : ""}`;
}
