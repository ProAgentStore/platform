import type { IncomingMessage } from "node:http";
import { parseBrowserWebsiteAccess } from "./browser-website-access.js";
/** The authenticated relay injects this reserved field after stripping any model-supplied value. */
export function websiteAccessFromRequest(req: Pick<IncomingMessage, "headers">, body: unknown) {
 if (req.headers["x-pags-website-policy"] !== "1") return undefined;
 return parseBrowserWebsiteAccess((body as Record<string, unknown> | null)?._pagsBrowserWebsiteAccess);
}
