/**
 * What the Coding tab says when a WRITE it already acted on turns out to have failed (#291).
 *
 * ── Why these are here and not inline
 *
 * Two reasons, and the second is the real one.
 *
 * `CodingTab.tsx` is on the file-size ratchet (#302) and adding a user-visible failure state to
 * three writes pushed it over the pin. But the pin only surfaced the problem: a sentence written
 * inline in a component is a sentence no test can read, and these three are the entire deliverable
 * of the fix. The bug was never "the request failed" — `api()` already records that — it was that
 * the UI went on displaying the outcome the user asked for. What replaces that display IS the fix,
 * so it belongs where it can be asserted, next to `./coding-loop-run` which exists for the same
 * reason.
 *
 * ── The rule they share
 *
 * Each of these three writes had already been rendered as done before the server was asked: the
 * toggle had flipped, the session had opened, the pane had emptied. So every message here has to do
 * a thing an ordinary error toast does not — it has to WITHDRAW something the user is looking at,
 * and say what is true instead. "Couldn't save" is not enough when the screen still shows the save.
 */

/**
 * Format the tail of an error for a user-facing sentence.
 *
 * The `err instanceof Error ? err.message : String(err)` idiom used everywhere else in this tab is
 * wrong for the one case that matters most here. A rejection from `fetch`/`api` is frequently a
 * plain object, and `String({code:"ETIMEDOUT"})` is `"[object Object]"` — so the sentence that
 * exists to replace a silent failure would end by telling the user nothing, in the exact situation
 * (a network-level drop) that these three writes fail in most often. Serialise instead; the shape
 * is usually small and it is the only clue the user can relay.
 */
function detailOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		const json = JSON.stringify(err);
		// `undefined`, a function, or a symbol stringify to `undefined`, not to a string.
		if (json && json !== "{}") return json;
	} catch {
		// Circular or a throwing `toJSON` — fall through to the primitive form, which for these
		// is still better than nothing.
	}
	return Object.prototype.toString.call(err);
}

/**
 * Work mode (`direct` ⇄ `issues`) failed to save.
 *
 * The flipped toggle IS the receipt, and the setting is read SERVER-side — issues mode is what
 * makes the Loop source its objective from GitHub rather than from the box. So a swallowed save
 * left the user looking at "issues", getting "direct" behaviour from the platform, and finding the
 * toggle back where it started on the next visit. The caller reverts the toggle; this says why it
 * moved back under their finger, which is otherwise indistinguishable from a misclick.
 */
export function workModeSaveFailureNotice(err: unknown): string {
	return `Couldn't switch work mode — it's still set the old way. ${detailOf(err)}`;
}

/**
 * The session opened, but the Engine could not be (re)attached.
 *
 * A refused start is the difference between "the engine has not spoken yet" and "there is no
 * engine", and the two rendered identically: the failure was swallowed, so the session opened
 * looking exactly like one that is simply quiet — which is the correct reading for the FIRST case.
 * A machine that is offline is the common cause and it has a one-command fix, so name it rather
 * than leaving the user to interpret an empty pane.
 */
export function sessionAttachFailureNotice(err: unknown): string {
	return `Couldn't attach to this session — the Engine isn't running (${detailOf(err)}). If your machine is offline, run \`pags up\` and reopen the session.`;
}

/**
 * Clearing the Co-pilot history failed.
 *
 * Clearing emptied the pane WHETHER OR NOT the DELETE landed, so a failed clear looked exactly like
 * a successful one until the next reload put the whole conversation back. The local empty is a
 * CLAIM about the server; the caller now only makes it once the server agrees, and this reports the
 * case where it did not — including the part the user most needs, that nothing was deleted.
 */
export function clearHistoryFailureNotice(err: unknown): string {
	return `Couldn't clear the history: ${detailOf(err)}. Nothing was deleted.`;
}
