import type { WebsiteBuilderJobCall } from "./website-builder-jobs.js";

/**
 * The terminal is intentionally not an evidence authority.  A subscription CLI
 * can describe which FWS session it worked on, but URLs and QA results shown on
 * a board ticket must come from the PAGS broker's own recorded FWS responses.
 */
export interface WebsiteBuilderWorkerClaim {
	session_id: string;
	template_slug: string;
	summary?: string;
}

export interface TrustedWebsiteBuilderEvidence {
	session_id: string;
	template_slug: string;
	quality_report: Record<string, unknown>;
	desktop_preview: string;
	mobile_preview: string;
	/** Broker-confirmed FWS capture metadata. The connector retains metadata, not JPEG bytes. */
	captures: {
		desktop: { preview_url: string; mime_type: "image/jpeg"; width: number; height: number };
		mobile: { preview_url: string; mime_type: "image/jpeg"; width: number; height: number };
	};
	ready_for_human_review: true;
	/** Kept for diagnostics, never used to authorise a deployment. */
	summary?: string;
}

export interface WebsiteBuilderBrokerState {
	fwsSessionId: string | null;
	noindexConfirmed: boolean;
	mcpUrl: string;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** `mcp_call_tool` records its unwrapped response as {tool,ok,data}. */
function recordedData(result: string): Record<string, unknown> | null {
	try {
		const outer = object(JSON.parse(result));
		if (!outer) return null;
		return object(outer.data) ?? outer;
	} catch {
		return null;
	}
}

function sameSession(call: WebsiteBuilderJobCall, sessionId: string): boolean {
	return call.args.session_id === sessionId;
}

function brokeredFor(call: WebsiteBuilderJobCall, state: WebsiteBuilderBrokerState, sessionId: string): boolean {
	return call.metadata.source === "pags.website_builder_broker" &&
		call.metadata.endpoint === state.mcpUrl &&
		call.metadata.session_id === sessionId;
}

type Capture = { preview_url: string; mime_type: "image/jpeg"; width: number; height: number };

function captureMetadata(call: WebsiteBuilderJobCall, state: WebsiteBuilderBrokerState, sessionId: string, viewport: "desktop" | "mobile"): Capture | null {
	if (!call.success || !brokeredFor(call, state, sessionId) || call.tool !== "capture_preview" || !sameSession(call, sessionId) || call.args.viewport !== viewport) return null;
	const data = recordedData(call.result);
	if (!data || data.session_id !== sessionId || data.viewport !== viewport || typeof data.preview_url !== "string") return null;
	// FWS emits an https preview URL.  Do not let a terminal-provided arbitrary URL
	// become part of the approval ticket just because it resembles one.
	try {
		const url = new URL(data.preview_url);
		if (url.protocol !== "https:" || data.mime_type !== "image/jpeg") return null;
		const width = data.width;
		const height = data.height;
		const expected = viewport === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 };
		if (width !== expected.width || height !== expected.height) return null;
		return { preview_url: url.toString(), mime_type: "image/jpeg", width, height };
	} catch {
		return null;
	}
}

function renderedPreviewUrl(call: WebsiteBuilderJobCall, state: WebsiteBuilderBrokerState, sessionId: string): string | null {
	if (!call.success || !brokeredFor(call, state, sessionId) || call.tool !== "get_rendered_preview" || !sameSession(call, sessionId)) return null;
	const data = recordedData(call.result);
	// FWS's get_rendered_preview text payload contains the URL but not session_id;
	// the broker-stamped metadata and forced call argument above bind it to this job.
	if (!data || typeof data.preview_url !== "string") return null;
	try {
		const url = new URL(data.preview_url);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

/**
 * Corroborate a worker's narrow session/template claim with the broker audit
 * trail, then build the ticket evidence entirely from trusted FWS responses.
 */
export function trustedWebsiteBuilderEvidence(
	claim: WebsiteBuilderWorkerClaim,
	calls: WebsiteBuilderJobCall[],
	state: WebsiteBuilderBrokerState,
): TrustedWebsiteBuilderEvidence | null {
	if (state.fwsSessionId !== claim.session_id || !state.noindexConfirmed) return null;
	const created = calls.some((call) => {
		if (!call.success || call.tool !== "create_site") return false;
		const data = recordedData(call.result);
		return brokeredFor(call, state, claim.session_id) && data?.session_id === claim.session_id && data.template_slug === claim.template_slug;
	});
	if (!created) return null;

	let quality: Record<string, unknown> | null = null;
	for (const call of calls) {
		if (!call.success || !brokeredFor(call, state, claim.session_id) || call.tool !== "get_quality_report" || !sameSession(call, claim.session_id)) continue;
		const data = recordedData(call.result);
		if (data?.ready_for_human_review === true) quality = data;
	}
	if (!quality) return null;

	let renderedPreview: string | null = null;
	for (const call of calls) renderedPreview = renderedPreviewUrl(call, state, claim.session_id) ?? renderedPreview;
	if (!renderedPreview) return null;

	// Last successful capture wins: it is the one taken after the last refinement.
	let desktop: Capture | null = null;
	let mobile: Capture | null = null;
	for (const call of calls) {
		desktop = captureMetadata(call, state, claim.session_id, "desktop") ?? desktop;
		mobile = captureMetadata(call, state, claim.session_id, "mobile") ?? mobile;
	}
	if (!desktop || !mobile || desktop.preview_url !== renderedPreview || mobile.preview_url !== renderedPreview) return null;

	return {
		session_id: claim.session_id,
		template_slug: claim.template_slug,
		quality_report: quality,
		desktop_preview: desktop.preview_url,
		mobile_preview: mobile.preview_url,
		captures: { desktop, mobile },
		ready_for_human_review: true,
		...(claim.summary ? { summary: claim.summary } : {}),
	};
}
