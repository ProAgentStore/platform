/** Usage tracking for creator payouts. */
export interface UsageClient {
	track(event: string, metadata?: Record<string, unknown>): Promise<void>;
}
