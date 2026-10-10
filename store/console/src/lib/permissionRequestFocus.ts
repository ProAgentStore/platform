/** Query state for a verified permission-request console link (#1009). */
export const PERMISSIONS_CONTROL_ID = "permissions-and-connections";

/**
 * Only the exact `focus=permissions` URL built by the API opens this control.  A request id on
 * another Settings deep link is ignored instead of silently changing the page's focus.
 */
export function permissionRequestFocus(search: string): { controlId: typeof PERMISSIONS_CONTROL_ID; requestId: string } | null {
	const query = new URLSearchParams(search);
	const requestId = query.get("focus") === "permissions" ? query.get("permission_request")?.trim() : null;
	return requestId ? { controlId: PERMISSIONS_CONTROL_ID, requestId } : null;
}
