/** The instance-level Settings tab's Agent sub-tab (#1589), where the Brain and Coding engine are set. In-router: the console basename is the router's. */
export function agentSettingsPath(instanceId: string): string {
	return `/instances/${encodeURIComponent(instanceId)}/settings?subtab=agent`;
}
