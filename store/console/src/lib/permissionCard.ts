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
