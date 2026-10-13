/**
 * Which instance a permission request belongs to, as the card names it (#1009). The page header shows
 * the instance too, but the card is what the push focuses — so it carries the identity itself: the
 * instance's name, its id when the name is unknown, never just "this instance".
 */
export function permissionCardInstanceLabel(instanceName: string | null | undefined, instanceId: string): string {
	const name = instanceName?.trim();
	return name ? `${name} (${instanceId})` : instanceId;
}

export interface PermissionCardExpiry {
	/** True once the request can no longer be approved: marked expired, or pending past its deadline. */
	expired: boolean;
	text: string;
}

/**
 * When a permission request expires, as the card says it (#1058), in the viewer's local time. A request
 * stays `pending` in storage until something acts on it, and approving one past `expiresAt` is refused
 * (409 expired) — so a pending request past its deadline reads as expired here too. Null for a request
 * that is decided some other way (approved, denied, …) or carries no readable deadline.
 */
export function permissionCardExpiry(
	request: { status: string; expiresAt: string },
	now: number,
	format: { locale?: string; timeZone?: string } = {},
): PermissionCardExpiry | null {
	const at = Date.parse(request.expiresAt);
	if (!Number.isFinite(at)) return null;
	if (request.status !== "pending" && request.status !== "expired") return null;
	const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: format.timeZone };
	const day = (t: number) => new Date(t).toLocaleDateString(format.locale, { timeZone: format.timeZone });
	// A deadline on another day than today names the day too.
	if (day(at) !== day(now)) Object.assign(opts, { day: "numeric", month: "short" });
	const when = new Date(at).toLocaleString(format.locale, opts);
	if (request.status === "expired" || at <= now) return { expired: true, text: `Expired at ${when}. It can no longer be approved; the agent must ask again.` };
	const mins = Math.floor((at - now) / 60_000);
	const left = mins < 1 ? "less than a minute left" : mins < 60 ? `${mins} min left` : `${Math.floor(mins / 60)} h ${mins % 60} min left`;
	return { expired: false, text: `Expires at ${when} (${left}).` };
}

export interface PermissionCardAction {
	label: string;
	decision: "approve" | "deny";
	/** The connector write-access mode sent with an approval; only `connector_consent` takes one. */
	mode?: "always" | "ask";
	primary?: boolean;
}

/**
 * The decisions a permission card offers, by request kind (#1059). A `connector_consent` request grants a
 * connector WRITE access, always or asked each time. A `tool_enabled` request is something else: approving
 * it switches that one declared tool back on for the instance, and it stays on (`grantRequested` removes
 * it from the disabled tools; the mode is not used), then the blocked call runs once. So it gets the
 * tool's own name and says that, instead of "Allow write access" / "Ask each time", which were untrue.
 */
export function permissionCardActions(request: { control?: string; operationKind: string }): { actions: PermissionCardAction[]; note: string | null; approved: string } {
	const deny: PermissionCardAction = { label: "Deny", decision: "deny" };
	if (request.control === "tool_enabled") {
		const tool = request.operationKind;
		return {
			actions: [{ label: `Switch on ${tool}`, decision: "approve", primary: true }, deny],
			note: `Approving switches ${tool} back on for this instance — it stays on until you switch it off under Tools — and runs the blocked call once.`,
			approved: `${tool} is switched on, and the blocked call may resume once through its verified continuation.`,
		};
	}
	return {
		actions: [{ label: "Allow write access", decision: "approve", mode: "always", primary: true }, { label: "Ask each time", decision: "approve", mode: "ask" }, deny],
		note: null,
		approved: "Permission verified. The blocked operation may resume once through its verified continuation.",
	};
}
