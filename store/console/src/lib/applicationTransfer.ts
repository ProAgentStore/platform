/** Owner-safe receipt returned after explicitly transferring one reviewed material set (#1010). */
export interface PreparedApplicationTransferReceipt {
	id: string;
	sourceApplicationId: string;
	destinationApplicationId: string;
	destinationRunnerInstanceId: string;
	connectionId: string;
	stateVersion: number;
	resumeSha256: string;
	coverLetterSha256: string;
	deliveryId: string | null;
	deliveryStatus: string | null;
	runId: string | null;
	status: "queued" | "delivered" | "retrying" | "dead" | "consumed";
}
