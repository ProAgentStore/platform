/**
 * The notification vocabulary and per-instance answer the mocked console routes serve (#1595).
 *
 * Built from the real vocabulary and the real gate resolution, so a row added to `NOTIFICATION_TYPES` shows up in the
 * 17-row Gmail Scout fixture as a failing count rather than a stale mock. `effective` is the plain default (no rule) except
 * for rows a test gives an instance rule.
 */
import { gatedOutRowKeys } from "../workers/api/src/lib/notification-applicability";
import { NOTIFICATION_TYPES } from "../workers/api/src/lib/notifications";
import { OWNER_ATTENTION_EVENTS } from "../workers/api/src/lib/owner-attention";

export type FixtureRule = { type?: string; event?: string; severity?: string; push?: boolean; inapp?: boolean };

export const NOTIFICATION_VOCABULARY = {
	types: NOTIFICATION_TYPES,
	events: OWNER_ATTENTION_EVENTS,
	channels: [
		{ id: "inapp", label: "In the console", description: "The bell list.", optional: true },
		{ id: "push", label: "Push to my devices", description: "Every device you have enabled alerts on.", optional: true },
	],
	severities: ["update", "alert"],
};

/** The capabilities the two sweep fixtures resolve to (`SETTINGS_SWEEP_FIXTURES` in console.spec.ts). */
export const GMAIL_SCOUT_CAPS = { surfaces: [], runtime: "local_browser" } as never;

/** What `GET /v1/instances/:id/notifications` answers for an instance with these capabilities and rules. */
export function notificationsResponse(instanceId: string, caps: never, rules: FixtureRule[] = []) {
	const cell = (match: (r: FixtureRule) => boolean) => {
		const rule = rules.find(match);
		return (channel: "inapp" | "push") => (rule && rule[channel] !== undefined ? { allowed: rule[channel] as boolean, source: "instance", rule } : { allowed: true, source: "default" });
	};
	const effective = [
		...OWNER_ATTENTION_EVENTS.map((e) => {
			const c = cell((r) => r.event === e.id);
			return { type: "", severity: e.kind, event: e.id, inapp: c("inapp"), push: c("push") };
		}),
		...NOTIFICATION_TYPES.flatMap((t) =>
			(["update", "alert"] as const).map((severity) => {
				const c = cell((r) => r.type === t.id && (!r.severity || r.severity === severity));
				return { type: t.id, severity, inapp: c("inapp"), push: c("push") };
			}),
		),
	];
	return {
		instanceId,
		rules,
		inherited: { rules: [], legacy: [], muted: [], instances: [] },
		applicability: { hidden: gatedOutRowKeys(caps) },
		effective,
	};
}
