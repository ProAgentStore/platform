/** Only the control plane's validated launch settings become runner headers; never values in a task body. */
export function browserSettingsHeaders(command: { browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown }): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [value, allowed, header] of [
		[command.browserMode, ["headed", "headless"], "X-PAGS-Browser-Mode"],
		[command.browserEngine, ["chrome", "msedge", "chromium", "firefox", "webkit"], "X-PAGS-Browser-Engine"],
		[command.browserProfilePolicy, ["persistent", "ephemeral"], "X-PAGS-Browser-Profile-Policy"],
	] as const) {
		if (value === undefined) continue;
		if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid ${header} setting`);
		headers[header] = value;
	}
	return headers;
}
