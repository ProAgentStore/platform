/** A PAS remote sign-in request's state, as the owner's machine last reported it (#1005). */
export type RemoteAuthState = "pending" | "approving" | "approved_awaiting_machine" | "consumed" | "connected" | "denied" | "expired" | "cancelled" | "failed";

/** One PAS remote sign-in request, as `GET /v1/remote-auth/requests/:id` returns it (#1005). Public details only. */
export interface RemoteAuthRequestView {
	id: string;
	pasRequestId: string;
	agent: { id: string; label: string };
	machine: { id: string; label: string };
	relayedBy: { node: string | null; machineId: string | null };
	service: "ProAppStore MCP";
	resource: string;
	scopes: string[];
	/** PAS's own approval page — linked, opened in an external browser; PAGS never calls it. */
	approvalUrl: string;
	state: RemoteAuthState;
	effectiveState: RemoteAuthState;
	expiresAt: string;
	lastReportedAt: string;
	createdAt: string;
	history: Array<{ at: number; state: RemoteAuthState }>;
}

export interface RemoteAuthRequestResponse {
	request: RemoteAuthRequestView;
}

/**
 * What a PAS remote sign-in request's page says in each state (#1005), and when it offers "Sign in".
 * The state is the owner's MACHINE's report of the PAS broker — PAGS never asks PAS — so every line says
 * what is known, and `connected` is shown only once the machine reported a real authenticated MCP read.
 */
export function remoteAuthStatusLine(state: RemoteAuthState): { text: string; tone: "ok" | "warn" | "muted"; terminal: boolean } {
	switch (state) {
		case "pending":
			return { text: "Waiting for you to approve it at ProAppStore.", tone: "warn", terminal: false };
		case "approving":
			return { text: "ProAppStore is checking your sign-in.", tone: "warn", terminal: false };
		case "approved_awaiting_machine":
			return { text: "Approved — waiting for the machine to pick it up.", tone: "warn", terminal: false };
		case "consumed":
			return { text: "The machine received it and is checking the connection.", tone: "warn", terminal: false };
		case "connected":
			return { text: "Connected — the machine made an authenticated ProAppStore MCP call.", tone: "ok", terminal: true };
		case "denied":
			return { text: "You denied this request. Nothing was granted.", tone: "muted", terminal: true };
		case "cancelled":
			return { text: "This request was cancelled. Nothing was granted. Start a new sign-in on the machine if you still need one.", tone: "muted", terminal: true };
		case "expired":
			return { text: "This request expired before it was completed. Nothing was granted. Start a new sign-in on the machine.", tone: "muted", terminal: true };
		case "failed":
			return { text: "The machine could not complete the sign-in. Nothing was granted. Start a new sign-in on the machine.", tone: "muted", terminal: true };
	}
}

/** "Sign in" is offered only while ProAppStore can still approve the request. */
export const remoteAuthCanSignIn = (state: RemoteAuthState) => state === "pending" || state === "approving";

/** A machine that has not reported for this long while the request is open is shown as possibly offline. */
export const REMOTE_AUTH_QUIET_MS = 2 * 60_000;
