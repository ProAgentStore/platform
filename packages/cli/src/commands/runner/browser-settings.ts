/** Only the control plane's validated launch settings become runner headers; never values in a task body. */
export function browserSettingsHeaders(command: { browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown; browserWebsiteAccess?: unknown }): Record<string, string> {
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
	if (command.browserWebsiteAccess !== undefined) headers["X-PAGS-Website-Policy"] = "1";
	return headers;
}

/** Reserved transport metadata is overwritten, never inherited from model action arguments. */
export function browserSettingsBody(command: { body?: unknown; browserWebsiteAccess?: unknown }): unknown {
 const body = command.body;
 if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body))) {
  if (command.browserWebsiteAccess !== undefined) throw new Error("Website policy requires an object request body");
  return body;
 }
 if (body === undefined && command.browserWebsiteAccess === undefined) return undefined;
 const { _pagsBrowserWebsiteAccess: _untrusted, ...rest } = (body ?? {}) as Record<string, unknown>;
 return { ...rest, ...(command.browserWebsiteAccess === undefined ? {} : { _pagsBrowserWebsiteAccess: command.browserWebsiteAccess }) };
}
