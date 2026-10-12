/**
 * The wire shape of a durable browser takeover (#1031) and its route responses — import-free, so the
 * console can compare its own copy against it in `store/console/src/lib/types.test.ts` (#1045).
 * The store that reads and writes the rows is `browser-takeovers.ts`.
 */
export const TAKEOVER_STATES = ["requested", "active", "resumed", "ended", "expired"] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];
export const TAKEOVER_REASONS = ["login_required", "captcha", "consent_required", "access_blocked", "paywall", "write_affordance", "manual"] as const;
export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];
export const TAKEOVER_SUBJECTS = ["local_browser_run", "runtime_task", "manual"] as const;
export type TakeoverSubject = (typeof TAKEOVER_SUBJECTS)[number];
export const TAKEOVER_END_REASONS = ["declined", "run_finished", "resumed_at_machine", "expired"] as const;
export type TakeoverEndReason = (typeof TAKEOVER_END_REASONS)[number];

export interface BrowserTakeover {
	id: string;
	instanceId: string;
	agentId: string;
	subjectKind: TakeoverSubject;
	subjectId: string;
	state: TakeoverState;
	reason: TakeoverReason;
	mobileAllowed: boolean;
	endReason: TakeoverEndReason | null;
	expiresAt: string;
	createdAt: string;
	activatedAt: string | null;
	endedAt: string | null;
	updatedAt: string;
}

/** `GET /v1/instances/:id/browser-takeovers` response. */
export interface BrowserTakeoverListResponse {
	takeovers: BrowserTakeover[];
}

/** `PATCH /v1/instances/:id/browser-takeovers/:takeoverId` response. */
export interface BrowserTakeoverTransitionResponse {
	takeover: BrowserTakeover;
	changed: boolean;
}
