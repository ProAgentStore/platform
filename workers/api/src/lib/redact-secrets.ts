/**
 * Secret redaction for the browser-agent action trail (#631).
 *
 * ── What went wrong
 *
 * The credentials vault protects the ATS account password properly: AES-256-GCM under a
 * wrapped DEK, owner-only reveal, a decrypt path careful enough to tell "no secret" apart
 * from "unreadable secret" (`credentials.ts`). Then the apply run took it out of the vault,
 * typed it into a form, and wrote the transcript of that typing to four plaintext stores:
 * `agent_events.context`, the runner's task-event mirror, `ats_apply_cache.notes` (served
 * straight back to the browser under Knowledge -> Rules & Tips), and the action log fed to
 * the next prompt.
 *
 * Measured in production before the fix: 18 of 500 `instance_task_events` on the one
 * apply-capable instance held the 14-char account password VERBATIM, across 6 tasks and 3
 * ATS hosts, in both `agent.decision` and `agent.shot`.
 *
 * ── Why the field NAME is not enough
 *
 * The obvious guard is "mask what is typed into a control called Password". It is
 * necessary and it is not sufficient: 9 of those 18 rows were `agent.shot` events whose
 * recorded control name was the EMPTY STRING. A name-based rule would have masked half the
 * exposure and reported success.
 *
 * So redaction is primarily VALUE-based. The loop knows the secret it was handed, and any
 * string on its way to a sink has that value substituted out — whatever field it went into,
 * whatever key it is nested under, and including the places nobody thinks of as a log: the
 * model's own `thought`, a runner read-back `feedback`, an ARIA `stuckSnapshot`.
 *
 * `isSecretFieldName` remains as the second half, for values we were never handed and so
 * cannot match on — a mid-run `request_user_info` answer, a security question.
 *
 * ── Why `collectJobSecrets` reads the job instead of taking a list
 *
 * A hand-maintained "these are the secrets" array is a thing the next field added to
 * `ApplyJob` gets left out of, silently, with no failing test — the same shape of bug as
 * the original. Reading the job's own keys means a future `job.apiToken` is redacted by the
 * commit that adds it.
 */

/** What a redacted value renders as. Deliberately not the field's length. */
export const SECRET_MASK = "••••";

/** Shorter than this and a "secret" is too generic to substitute out of prose safely. */
const MIN_SECRET_LEN = 6;

/** Object keys whose STRING value is a secret, wherever it appears on a job. */
const SECRET_KEY_RE = /(password|passwd|passphrase|secret|token|credential|apikey|api_key|\bpin\b|passcode)/i;

/**
 * Control labels whose typed value must never be logged even when we do not hold the value.
 * Over-masking a non-secret answer costs a line of debuggability; under-masking costs a
 * credential, so this list leans inclusive.
 */
const SECRET_FIELD_RE = new RegExp(
	[
		"pass\\s*word",
		"passwd",
		"pass\\s*phrase",
		"\\bpin\\b",
		"passcode",
		"\\bssn\\b",
		"social security",
		"tax file number",
		"\\btfn\\b",
		"national insurance",
		"\\bcvv\\b",
		"\\bcvc\\b",
		"card number",
		"credit card",
		"account number",
		"security answer",
		"secret question",
		"security question",
		"\\botp\\b",
		"one[- ]time (code|password)",
		"verification code",
		"\\b2fa\\b",
		"\\bmfa\\b",
		"\\bsecret\\b",
		"\\btoken\\b",
		"api key",
	].join("|"),
	"i",
);

/** Is this control's typed value a secret, judged by its accessible name / role? */
export function isSecretFieldName(name?: string, role?: string): boolean {
	const label = `${name ?? ""} ${role ?? ""}`.trim();
	if (!label) return false;
	return SECRET_FIELD_RE.test(label);
}

/**
 * Every secret value carried on a job object, read from the job's OWN keys.
 *
 * Picks up `password` on an `ApplyJob`, plus any future secret-named string field, plus the
 * `providedAnswers` the user supplied mid-run for a secret-named question. One level deep
 * into plain objects — enough for `providedAnswers`, and it stops well short of walking an
 * arbitrary graph.
 */
export function collectJobSecrets(job: unknown): string[] {
	const out: string[] = [];
	if (!job || typeof job !== "object") return out;
	const take = (key: string, value: unknown) => {
		if (typeof value !== "string" || value.length < MIN_SECRET_LEN) return;
		if (!SECRET_KEY_RE.test(key) && !isSecretFieldName(key)) return;
		out.push(value);
	};
	for (const [key, value] of Object.entries(job as Record<string, unknown>)) {
		take(key, value);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) take(k2, v2);
		}
	}
	return [...new Set(out)];
}

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type SecretRedactor = (text: string) => string;

/**
 * A redactor that substitutes every occurrence of every known secret.
 *
 * Case-insensitive on purpose: an ATS that upper-cases or trims what it echoes back in a
 * validation message would otherwise slip the value past a case-sensitive match. The
 * false-positive risk of matching a 14-char random string case-insensitively is nil.
 *
 * Returns the identity function when there is nothing to redact, so the common path costs
 * one comparison rather than a regex.
 */
export function makeSecretRedactor(secrets: string[]): SecretRedactor {
	const usable = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LEN))]
		// Longest first: a secret that contains another must be masked as a whole.
		.sort((a, b) => b.length - a.length);
	if (usable.length === 0) return (text) => text;
	const re = new RegExp(usable.map(escapeRe).join("|"), "gi");
	return (text) => (typeof text === "string" ? text.replace(re, SECRET_MASK) : text);
}

/** Does this look like a `BrowserAction` (the shape whose `text` we can judge by name)? */
function isActionShape(v: Record<string, unknown>): boolean {
	return typeof v.action === "string" && ("text" in v || "name" in v || "role" in v);
}

/**
 * A copy of an action with its typed value elided when the target control is a secret one.
 *
 * The action itself is never mutated — it is still handed to the runner in full, and the
 * fixation guard still keys on the real value. Only the DESCRIPTION of it is redacted.
 */
export function redactAction<A extends { action?: string; name?: string; role?: string; text?: string }>(a: A): A {
	if (!a || typeof a !== "object") return a;
	if (a.text == null || a.text === "") return a;
	if (!isSecretFieldName(a.name, a.role)) return a;
	return { ...a, text: SECRET_MASK };
}

/**
 * Deep-redact an event payload: every string through the value redactor, and any nested
 * action object also masked by field name.
 *
 * Bounded depth, because this runs on model-supplied structures and an unbounded walk over
 * one is a denial-of-service primitive, not a redactor.
 */
export function redactEventData(data: unknown, redact: SecretRedactor, depth = 0): unknown {
	if (depth > 6) return data;
	if (typeof data === "string") return redact(data);
	if (Array.isArray(data)) return data.map((v) => redactEventData(v, redact, depth + 1));
	if (data && typeof data === "object") {
		const src = data as Record<string, unknown>;
		const base = isActionShape(src) ? (redactAction(src as Parameters<typeof redactAction>[0]) as Record<string, unknown>) : src;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(base)) out[k] = redactEventData(v, redact, depth + 1);
		return out;
	}
	return data;
}
