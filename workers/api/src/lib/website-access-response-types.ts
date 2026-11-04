/** Import-safe owner response contract, shared with the console. */
export interface WebsiteGrantsResponse {
	domains: string[];
	decisions: Array<{ hostname: string; decision: "allow" | "deny" }>;
}
