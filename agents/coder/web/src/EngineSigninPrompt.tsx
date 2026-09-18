import Button from "./Button";

/** Returned by /capture when the engine is waiting for a human to sign in. */
export type AuthPrompt = { kind: "oauth-url" | "menu" | "unknown"; url: string | null; evidence: string; guidance: string };

/**
 * Sign-in relay (#coding-auth): the engine is blocked on a human signing in.
 *
 * Shown in BOTH the Co-pilot and Terminal views: a blocked engine looks like a dead session, and
 * the owner is as likely to be on the co-pilot view as the terminal when they notice nothing is
 * happening.
 *
 * The button does not open the link HERE, and must not: the CLI's OAuth uses a LOOPBACK redirect,
 * so the browser has to be on the runner machine — opening it on this laptop would redirect to
 * this laptop's localhost, where nothing is listening. `onStartSignin` is CodingTab's POST to
 * `/signin`, which opens it over there; `message` is that call's progress and outcome. The
 * request stays with the session state it needs, so this is three values in and no setters.
 */
export default function EngineSigninPrompt({ prompt, message, onStartSignin }: { prompt: AuthPrompt | null; message: string; onStartSignin: () => void }) {
	if (!prompt) return null;
	return (
		<div className="mb-2 rounded-lg border border-warning-line bg-warning-soft px-3 py-2">
			<div className="text-sm font-semibold">This engine is waiting for you to sign in</div>
			<p className="text-xs text-muted mt-0.5">{prompt.guidance}</p>
			{prompt.evidence && (
				<pre className="text-2xs text-muted mt-1 whitespace-pre-wrap break-all">{prompt.evidence}</pre>
			)}
			{prompt.kind === "oauth-url" && (
				<Button variant="primary" size="md" className="mt-2" onClick={onStartSignin}>
					Open sign-in on my runner
				</Button>
			)}
			{message && <div className="text-xs text-muted mt-1.5">{message}</div>}
		</div>
	);
}
