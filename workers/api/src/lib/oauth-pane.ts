/**
 * Interactive sign-ins read off a tmux pane (#967) — which link is live, and what a code-verifier
 * error means.
 *
 * `gcloud auth login --no-launch-browser` (and any PKCE login) prints its OWN sign-in link, with its
 * own `code_challenge` and `state`. A code from one attempt only works in THAT attempt. When a second
 * login is started before the first finishes, the pane carries two links, and a code from the older
 * one fails with `(invalid_grant) Invalid code verifier` — which reads as a bad code, not a superseded
 * link. On 2026-10-08 that cost the owner a round trip.
 *
 * Pure: the tmux tools read the pane they already have and put the notice in `tail`, outside the
 * pane's fence, because it is the platform's judgement and not terminal output. The capture joins
 * wrapped lines (`capture-pane -J`), so a long link is one line here.
 */

/** One sign-in attempt on the pane, keyed by its `state` (else `code_challenge`, else the URL). */
export interface OAuthAttempt {
	key: string;
	url: string;
	/** Where its link LAST appears on the pane; attempts are ordered by this. */
	at: number;
}

export interface OAuthPaneReading {
	/** Distinct sign-in attempts on the pane, oldest first. */
	attempts: OAuthAttempt[];
	/** The newest attempt's link — the only one whose code can work. */
	latestUrl: string | null;
	/** A code-verifier / invalid_grant error printed AFTER the newest link (an older one is history). */
	verifierMismatch: boolean;
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const VERIFIER_RE = /invalid code verifier|invalid_grant/gi;

/** An OAuth authorization request: carries a client id and either a PKCE challenge or a response type. */
function isAuthorizationUrl(url: string): boolean {
	return /[?&]client_id=/.test(url) && /[?&](code_challenge|response_type)=/.test(url);
}

function attemptKey(url: string): string {
	try {
		const q = new URL(url).searchParams;
		return q.get("state") ?? q.get("code_challenge") ?? url;
	} catch {
		return url;
	}
}

export function readOAuthPane(pane: string): OAuthPaneReading {
	const byKey = new Map<string, OAuthAttempt>();
	for (const m of pane.matchAll(URL_RE)) {
		const url = m[0].replace(/[).,;]+$/, "");
		if (!isAuthorizationUrl(url)) continue;
		const key = attemptKey(url);
		byKey.set(key, { key, url, at: m.index ?? 0 });
	}
	const attempts = [...byKey.values()].sort((a, b) => a.at - b.at);
	const latest = attempts.at(-1) ?? null;
	let lastError = -1;
	for (const m of pane.matchAll(VERIFIER_RE)) lastError = m.index ?? lastError;
	return { attempts, latestUrl: latest?.url ?? null, verifierMismatch: lastError >= 0 && lastError > (latest?.at ?? -1) };
}

/** What `Invalid code verifier` means, in words an owner can act on. */
export const VERIFIER_MISMATCH_EXPLANATION =
	"The sign-in failed with \"Invalid code verifier\": the code came from a sign-in link that a newer login attempt had superseded (or from another session) — the code itself was not mistyped. Each login prints its own link and only that attempt's code works. Start ONE clean login: stop any login still waiting (C-c), `clear`, run the login command once, and give the user only the link it prints.";

/**
 * The platform's note on this pane, or "" when there is nothing to say. Several attempts → name the
 * newest link as the only live one; an error after the newest link → the explanation above.
 */
export function oauthPaneNotice(pane: unknown): string {
	if (typeof pane !== "string" || !pane) return "";
	const r = readOAuthPane(pane);
	const notes: string[] = [];
	if (r.verifierMismatch) notes.push(VERIFIER_MISMATCH_EXPLANATION);
	else if (r.attempts.length > 1)
		notes.push(
			`(${r.attempts.length} different sign-in links are on this pane — more than one login was started here. Only the NEWEST is live; a code from an older link fails with "Invalid code verifier". Give the user only this link: ${r.latestUrl} — or, if unsure which login is still waiting, stop them (C-c), \`clear\`, and run the login once.)`,
		);
	return notes.join("\n");
}
