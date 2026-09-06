import { agoShort } from "./runnerPanel";

/**
 * What the API Keys panel says about a provider's last use.
 *
 * `tone` exists so the caller picks a token rather than matching on the prose: `never` is the
 * state the panel is FOR (#780) and has to be visually distinct, not a differently-worded
 * timestamp. The owner's question is "PAGS holds this key — is it spending it?", and a row that
 * renders an empty stamp answers it the same way a row that renders a recent one does.
 */
export type KeyUsage = { text: string; tone: "never" | "used" };

/**
 * `null` when there is nothing to say: a provider with no stored key cannot have a last-use, and
 * "never used" next to "Not set" would read as a claim about a key that does not exist.
 *
 * A present-but-unparseable stamp reports "used, time unknown" rather than falling through to
 * "never used". The distinction the panel exists to draw is used-vs-never, and a stamp we cannot
 * format is still a stamp the platform wrote — degrading it into the never state would invert the
 * one bit that matters. `agoShort` returns the literal "unknown" for that input, which is why this
 * checks for it instead of trusting the string.
 *
 * `lastUsedAt` is written by every path that spends the key: `lib/user-ai.ts:273` after a
 * successful Anthropic reply, `:500` after Workers AI, and `routes/keys.ts:485` in the key proxy.
 * It stamps on SUCCESS only, so a key that has never done anything but 401 stays "never used" —
 * which is the honest reading of "has the platform ever used this key".
 */
export function keyUsageLabel(p: { hasKey: boolean; lastUsedAt?: string | null }): KeyUsage | null {
	if (!p.hasKey) return null;
	if (!p.lastUsedAt) return { text: "never used", tone: "never" };
	const rel = agoShort(p.lastUsedAt);
	if (rel === "unknown") return { text: "used, time unknown", tone: "used" };
	return { text: `last used ${rel}`, tone: "used" };
}
