/** Owner-facing response from the exact-scope Actions recovery request. */
export interface ActionsRecoveryResponse {
	node: string;
	scope: { org: string } | { repo: string };
	recovery: { id: string; state: "queued" | "deferred_active_job"; requestedAt: number };
}
