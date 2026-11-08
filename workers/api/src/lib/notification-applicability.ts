/**
 * Which notification rows can this instance raise at all (#1595) — PURE.
 *
 * The vocabulary is platform-wide, so a Gmail Scout's instance editor listed Coder, Deploys and Build checks it can never
 * fire. Each type and event declares the `gate` it needs (`notifications.ts`, `owner-attention.ts`); this resolves a gate
 * against what `capabilitiesForInstance` already knows. Row keys are the console editor's (`event:<id>`,
 * `type:<id>:<severity>`), so the two sides count the same rows.
 */
import type { AgentCapabilities } from "./agent-capabilities.js";
import { NOTIFICATION_SEVERITIES } from "./notification-policy.js";
import { type NotificationGate, NOTIFICATION_TYPES } from "./notifications.js";
import { OWNER_ATTENTION_EVENTS } from "./owner-attention.js";

type GateInput = Pick<AgentCapabilities, "surfaces" | "runtime" | "tools">;

export function gateApplies(gate: NotificationGate | undefined, caps: GateInput): boolean {
	if (!gate || gate === "always") return true;
	if (gate === "account") return false;
	const sep = gate.indexOf(":");
	const kind = gate.slice(0, sep);
	const value = gate.slice(sep + 1);
	if (kind === "surface") return (caps.surfaces as string[]).includes(value);
	if (kind === "runtime") return value === "any" ? caps.runtime != null : caps.runtime === value;
	if (kind === "tool") return (caps.tools ?? []).includes(value);
	// An unrecognised gate shows the row: a typo must not hide a notification.
	return true;
}

/** Row keys whose gate does not apply to this instance. Rows with an instance rule are still shown by the console. */
export function gatedOutRowKeys(caps: GateInput): string[] {
	const out: string[] = [];
	for (const e of OWNER_ATTENTION_EVENTS) if (!gateApplies(e.gate, caps)) out.push(`event:${e.id}`);
	for (const t of NOTIFICATION_TYPES) {
		if (gateApplies(t.gate, caps)) continue;
		for (const severity of NOTIFICATION_SEVERITIES) {
			// A type that never raises an alert has no alert row (the editor skips it too).
			if (severity === "alert" && !t.alerts) continue;
			out.push(`type:${t.id}:${severity}`);
		}
	}
	return out;
}
