import { captionUrl } from "./browser-artifacts.js";
import { clipMarked } from "./clip-marked.js";

/** Page titles and tool errors can embed loading URLs, including partially clipped credentials. */
export function browserEvidenceText(value: unknown, max: number): string | undefined {
 if (typeof value !== "string") return undefined;
 // Refuse oversized input before scanning; never retain a potentially sensitive prefix.
 if (value.length > 16_384) return "[diagnostic text omitted: oversized]";
 const safe = value.replace(/https?:\/\/[^\s<>"'`]+/gi, url => captionUrl(url).url ?? "[URL redacted]");
 return clipMarked(safe, max, { within: true });
}
