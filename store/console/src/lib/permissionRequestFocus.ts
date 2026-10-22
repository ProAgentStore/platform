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

/**
 * The MCP server a console link points at (#1285): `?focus=permissions&mcp_endpoint=<https url>`. Only an https URL, already in the
 * normalized `host + path` form the panel keys connections on, is accepted — any other value is ignored rather than echoed into the page.
 */
export function mcpEndpointFocus(search: string): string | null {
	const query = new URLSearchParams(search);
	if (query.get("focus") !== "permissions") return null;
	const raw = query.get("mcp_endpoint")?.trim();
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) return null;
		return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/** The console path that opens one instance's Permissions tab on one MCP server. The endpoint carries no secret: it is a URL, normalized to host + path. */
export function mcpConnectionPath(instanceId: string, endpoint: string): string {
	return `/instances/${encodeURIComponent(instanceId)}/permissions?focus=permissions&mcp_endpoint=${encodeURIComponent(endpoint)}`;
}
