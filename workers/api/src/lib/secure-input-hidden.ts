/**
 * Reading a password prompt — before the value is typed, and after Enter (#1140).
 *
 * #966 verifies a delivery by seeing the value echoed on the pane. ssh, sudo, su, gpg and friends
 * turn echo off, so that check could only ever say "did not appear" and the secret could not be
 * used at all — found trying to ssh between two of the owner's laptops to recover a dead runner.
 *
 * A hidden prompt is verified by its OUTCOME instead: the pane must END with a recognised secret
 * prompt before anything is consumed, and after Enter the program must move on — new output, no
 * re-prompt, no "Permission denied" / "Sorry, try again" — within a window. Everything here reads
 * pane text only; none of it ever sees the value, so nothing it returns can carry one.
 */

/** A line that is asking for a secret and waiting at its end: `Password:`, `[sudo] password for me:`,
 *  `me@host's password:`, `Enter passphrase for key '/home/me/.ssh/id_ed25519':`, `Enter PIN for …:`. */
const SECRET_PROMPT = /\b(?:pass(?:word|phrase|code)|PIN)\b[^\n]{0,160}?[:：]\s*$/i;

/** What a program prints when it rejected the secret — matched on the output AFTER the prompt only. */
const REJECTIONS: Array<[RegExp, string]> = [
	[/permission denied/i, "Permission denied"],
	[/sorry, try again/i, "Sorry, try again"],
	[/authentication (?:failure|failed)/i, "authentication failure"],
	[/login incorrect/i, "Login incorrect"],
	[/(?:incorrect|wrong|invalid|bad) (?:password|passphrase|pin)/i, "incorrect password"],
	[/access denied/i, "Access denied"],
	[/too many (?:authentication failures|incorrect password attempts)/i, "too many attempts"],
];

/** How long a submitted secret is watched for a rejection, and how often. Mutable for tests only. */
export const hiddenOutcomeTiming = { windowMs: 6_000, pollMs: 1_000 };

function nonEmptyLines(pane: string): string[] {
	return pane
		.replace(/\r/g, "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== "");
}

/** The pane's last non-empty line, when it is a secret prompt waiting for input — else null. */
export function trailingSecretPrompt(pane: string): string | null {
	const last = nonEmptyLines(pane).at(-1) ?? "";
	return SECRET_PROMPT.test(last) ? last.trim() : null;
}

/**
 * The output that appeared after the prompt the value was typed at.
 *
 * The anchor is the last (up to) three non-empty lines of the pane before typing, ending at the
 * prompt. The pane only grows below it, so the original is the anchor's k-th occurrence in the new
 * pane, k being how often it occurred before — a re-prompt after an earlier identical failure
 * repeats all three lines, and the LAST occurrence would then be the new one. Whatever follows on
 * the prompt's own row (typed characters, a sudo `pwfeedback` row of asterisks) is not output and is
 * dropped. An anchor that scrolled away leaves the whole pane.
 */
export function outputAfterPrompt(before: string, after: string): string {
	const prior = nonEmptyLines(before);
	const anchorLines = prior.slice(-3);
	const flat = nonEmptyLines(after).join("\n");
	if (!anchorLines.length) return flat;
	const anchor = anchorLines.join("\n");
	const nth = (hay: string, k: number) => {
		let at = -1;
		for (let i = 0; i < k; i++) {
			at = hay.indexOf(anchor, at + 1);
			if (at === -1) return -1;
		}
		return at;
	};
	const flatBefore = prior.join("\n");
	let k = 0;
	for (let i = flatBefore.indexOf(anchor); i !== -1; i = flatBefore.indexOf(anchor, i + 1)) k++;
	const at = nth(flat, Math.max(1, k));
	if (at === -1) return flat;
	const rest = flat.slice(at + anchor.length);
	const nl = rest.indexOf("\n");
	return nl === -1 ? "" : rest.slice(nl + 1);
}

export type HiddenOutcome =
	| { kind: "accepted" }
	| { kind: "rejected"; why: string }
	| { kind: "reprompted"; prompt: string }
	| { kind: "waiting" };

/** One look at the pane after Enter. `waiting` = nothing new yet, the prompt line is all there is. */
export function judgeHiddenOutcome(before: string, after: string): HiddenOutcome {
	const output = outputAfterPrompt(before, after);
	if (!output.trim()) return { kind: "waiting" };
	for (const [re, why] of REJECTIONS) if (re.test(output)) return { kind: "rejected", why };
	const again = trailingSecretPrompt(output);
	if (again) return { kind: "reprompted", prompt: again };
	return { kind: "accepted" };
}

/**
 * Watch the pane for the whole window: a rejection or re-prompt ends it early; output that is still
 * clean when it closes is an acceptance; a pane that never moved past the prompt is `waiting`.
 */
export async function watchHiddenOutcome(before: string, firstLook: string, capture: () => Promise<string>): Promise<HiddenOutcome> {
	const { windowMs, pollMs } = hiddenOutcomeTiming;
	const deadline = Date.now() + windowMs;
	let verdict = judgeHiddenOutcome(before, firstLook);
	while (verdict.kind === "accepted" || verdict.kind === "waiting") {
		if (Date.now() >= deadline) return verdict;
		await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
		const pane = await capture().catch(() => null);
		if (pane != null) verdict = judgeHiddenOutcome(before, pane);
	}
	return verdict;
}
