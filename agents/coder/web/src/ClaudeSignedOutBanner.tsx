/**
 * Claude Code is signed out on the runner — what to do about it (#776 slice).
 *
 * A component because there are TWO session views and this block was written out in both, word
 * for word: the single-repo surface and the multi-repo one. Two copies of an instruction is how
 * one of them comes to name a command the other has stopped recommending. Same reasoning, and
 * the same shape, as ./EngineTurnBanner and ./OpenNoticeBanners.
 *
 * WHEN it shows is not decided here. `isClaudeSignedOut` (./engine-auth-view, with its own tests)
 * owns the transcript pattern and the engine gate that keeps a Codex user from being told to run
 * `claude setup-token`; the solo surface additionally shows it on the Terminal view only. This
 * renders the sentence and its two ways out, which are the caller's: where Profile lives is the
 * router's business and restarting is the session's.
 */
export default function ClaudeSignedOutBanner({ onOpenProfile, onRestart }: { onOpenProfile: () => void; onRestart: () => void }) {
	return (
		<div className="bg-warning-soft border border-warning-line text-warning rounded-lg p-2.5 m-2 text-sm">
			<b>Claude Code is signed out on your runner.</b> Run <code>claude setup-token</code> on any machine (it opens a browser),
			save the token under <button type="button" onClick={onOpenProfile} className="underline font-semibold">Profile → API keys → Claude Code</button>,
			then <button type="button" onClick={onRestart} className="underline font-semibold">Restart</button> this session.
		</div>
	);
}
