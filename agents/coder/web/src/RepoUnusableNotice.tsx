import { FolderCog } from "lucide-react";
import Button from "./Button";
import { repoRepairNotice } from "./repo-repair";
import type { CodingRepo } from "./types";

/**
 * "This checkout is unusable — here is the field that fixes it" (#67).
 *
 * ONE component for BOTH surfaces, which is the point rather than tidiness. This file has two
 * repo surfaces — `ReposList` for a multi-repo Coder and `CodingTab`'s solo branch for a
 * `coder-repo`, which is the agent the incident in ./repo-repair happened on — and before this
 * the failure was reported on one of them and not the other. A notice maintained twice across two
 * surfaces is how the engine-turn banner shipped into one session view and not the other (#545),
 * measured on this same tree; the single-repo owner was on the wrong side of that split here, and
 * a `coder-repo` subscriber is the ONLY kind of owner who can hit this with no list to fall back
 * on.
 *
 * Returns null unless the machine has actually refused the path, so both callers can render it
 * unconditionally and neither has to re-derive the condition. The decision and the wording are
 * ./repo-repair's, with their own tests; what is here is the layout.
 */
export default function RepoUnusableNotice({ repo, onFix, testId }: {
	repo: CodingRepo;
	/** Open this repo's settings sheet, where "Folder on your machine" is. */
	onFix: () => void;
	/** The list gives each row its own, so a multi-repo assertion can name WHICH repo complained. */
	testId?: string;
}) {
	const notice = repoRepairNotice(repo);
	if (!notice) return null;
	return (
		<div data-testid={testId ?? "repo-unusable"} className="mt-2 bg-danger-soft border border-danger-line text-danger rounded-lg p-2 text-xs">
			{/* `break-words` because a checkout path is long and this card is 320px wide on a phone. */}
			<p className="break-words">{notice.sentence}</p>
			<p className="mt-1 text-muted break-words">{notice.detail}</p>
			{notice.action && (
				// The CONTROL, not a sentence naming it. The prose here used to read "Point it at the
				// real checkout (⚙ Repo settings)", which is a sign pointing at a button — the shape
				// #411 removed from the empty state one file over, for the same reason.
				<Button size="sm" className="mt-1.5" onClick={onFix} title="Open repo settings at the folder field">
					<FolderCog size={13} /> {notice.action}
				</Button>
			)}
		</div>
	);
}
