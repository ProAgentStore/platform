// The console half of retargeting a binding after its GitHub repository was renamed (#1012).
//
// Pure, so the request the sheet sends and the words it shows are pinned without a browser. The
// server decides everything; this only builds the explicit request (expected-current comes from the
// row the sheet was opened on, never re-derived) and names the server's blocker codes in plain words.
import type { CodingRepo } from "./types";

export interface RetargetDestination {
	owner: string;
	name: string;
	githubId: string;
}

/** The POST body, or null while the destination is incomplete. Expected-current is the row as listed. */
export function retargetRequestBody(repo: CodingRepo, dest: RetargetDestination, dryRun: boolean) {
	const [owner, name] = (repo.githubRepo ?? "").split("/");
	const githubId = Number(dest.githubId.trim());
	if (!owner || !name || !dest.owner.trim() || !dest.name.trim() || !Number.isSafeInteger(githubId) || githubId < 1) return null;
	return {
		expectedCurrent: { owner, name, version: repo.bindingVersion ?? 1, ...(repo.githubRepositoryId ? { githubId: repo.githubRepositoryId } : { githubId }) },
		destination: { owner: dest.owner.trim(), name: dest.name.trim(), githubId },
		dryRun,
	};
}

const BLOCKERS: Record<string, string> = {
	active_session: "A session on this repo is still open — end it first.",
	session_lock: "A run is driving this repo's session.",
	active_run: "A run on this repo is still going or waiting on you.",
	queued_work: "Objectives are queued for this repo — they would otherwise run against the new name.",
	pending_start: "A run on this repo is starting.",
	runner_offline: "Your machine is not connected, so its checkout cannot be checked.",
	local_origin_unreadable: "Your machine could not read the checkout's origin.",
	local_origin_mismatch: "The checkout's origin still names the old repository.",
	managed_clone_origin_unverifiable: "This repo has no folder on your machine to check. Set its folder first.",
};

export function describeRetargetBlocker(code: string): string {
	return BLOCKERS[code] ?? code;
}
