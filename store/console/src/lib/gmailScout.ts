/** One completed Gmail Job Search Scout ingest, returned by its manual scan endpoint. */
export interface GmailScoutScanResult {
	mailbox: string;
	candidates: number;
	added: number;
	deduped: number;
	lastMessageId: string | null;
}

/** `POST /v1/instances/:id/gmail-scout/scan` response. */
export interface GmailScoutScanResponse {
	scan: GmailScoutScanResult;
}
