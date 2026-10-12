/**
 * Which instance a permission request belongs to, as the card names it (#1009). The page header shows
 * the instance too, but the card is what the push focuses — so it carries the identity itself: the
 * instance's name, its id when the name is unknown, never just "this instance".
 */
export function permissionCardInstanceLabel(instanceName: string | null | undefined, instanceId: string): string {
	const name = instanceName?.trim();
	return name ? `${name} (${instanceId})` : instanceId;
}
