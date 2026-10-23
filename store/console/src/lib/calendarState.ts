/** Google Calendar's live connection state as `/v1/calendar/status?check=1` reports it (#1313). */
export type CalendarAccess = "ok" | "not_connected" | "revoked" | "unconfigured" | "error";

export interface CalendarStatus {
	access: CalendarAccess;
	account: string | null;
	accounts: number;
	message: string | null;
	checked: boolean;
	reach: { grants: number; instances: number };
}

export interface CalendarGrant {
	id: string;
	resourceId: string;
	resourceName: string;
	resourceType: string;
}

export interface CalendarGrantListResponse {
	grants: CalendarGrant[];
}

export interface CalendarGrantResponse {
	grant: CalendarGrant;
}

/** What the owner reads about the connection, and whether granting a calendar can work right now. */
export function calendarStateLine(status: CalendarStatus | null): { text: string; tone: "ok" | "warn" | "muted"; canGrant: boolean } {
	if (!status) return { text: "Checking Google Calendar…", tone: "muted", canGrant: false };
	switch (status.access) {
		case "ok":
			return { text: `Connected${status.account ? ` as ${status.account}` : ""} — access works.`, tone: "ok", canGrant: true };
		case "revoked":
			return { text: "Google rejected the stored Calendar access — it was revoked or expired. Reconnect Google Calendar in Preferences → Connections. Granted calendars stay listed but cannot be read until you do.", tone: "warn", canGrant: false };
		case "not_connected":
			return { text: "Google Calendar is not connected. Connect it in Preferences → Connections, then grant this agent a calendar.", tone: "warn", canGrant: false };
		case "unconfigured":
			return { text: "Google Calendar sign-in is not configured on this deployment, so it cannot be connected.", tone: "warn", canGrant: false };
		default:
			return { text: status.message || "Google Calendar access could not be checked just now.", tone: "warn", canGrant: false };
	}
}
