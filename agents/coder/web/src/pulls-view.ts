import { buildState, type BuildState } from "./builds-view";

/**
 * Pure rendering rules for the Pulls panel (#401) — the parts worth pinning without a DOM.
 *
 * The Coder's safest mode (`mergePolicy: "pr"`, #314) does the work, opens a pull request and
 * STOPS. Everything here is about reading that artefact honestly: an unknown is shown as unknown,
 * and only the one state that actually blocks a merge is allowed to look alarming.
 */

export type ReviewState = "approved" | "changes_requested" | "commented" | "none" | "unknown";

export interface PullRow {
	number: number;
	title: string;
	state: string;
	draft: boolean;
	merged: boolean;
	author: string;
	branch: string;
	baseBranch: string;
	labels: string[];
	updatedAt: string;
	url: string;
	mergeable: boolean | null;
	mergeableState: string;
	review: ReviewState;
	checks?: { status?: string; conclusion?: string | null; url?: string; name?: string } | null;
	agentAct?: { traceId: string; act: string; at: string; sessionId: string | null } | null;
}

/** The single word a row shows for where the review is. `unknown` renders nothing. */
export function reviewLabel(review: ReviewState): string | null {
	switch (review) {
		case "approved":
			return "Approved";
		case "changes_requested":
			return "Changes requested";
		case "commented":
			return "Commented";
		default:
			// "none" is the ordinary state of a new PR, and "unknown" means we did not ask. Neither
			// is worth a badge; a "No reviews" chip on every fresh PR is noise, not information.
			return null;
	}
}

export type MergeTone = "clean" | "conflict" | "blocked" | "unknown";

/**
 * How a row reports mergeability.
 *
 * `mergeable === null` is UNKNOWN, never "conflicted": the list endpoint omits the field and the
 * detail endpoint answers null until GitHub's background job finishes. Telling an owner their PR
 * conflicts because nobody has computed it yet is exactly the false alarm this panel exists to
 * avoid — they would go and rebase a branch that merges fine.
 */
export function mergeTone(pull: Pick<PullRow, "mergeable" | "mergeableState" | "draft">): { tone: MergeTone; label: string } | null {
	if (pull.draft) return { tone: "unknown", label: "Draft" };
	if (pull.mergeable === false) return { tone: "conflict", label: "Conflicts" };
	if (pull.mergeable === null) return null;
	// `blocked` is GitHub's word for "mergeable, but a required review or check is not satisfied".
	if (pull.mergeableState === "blocked") return { tone: "blocked", label: "Blocked" };
	if (pull.mergeableState === "behind") return { tone: "blocked", label: "Behind base" };
	return { tone: "clean", label: "Mergeable" };
}

/** A PR's CI, mapped through the SAME rule the Builds panel uses — one idea, two views. */
export function checksState(pull: Pick<PullRow, "checks">): BuildState {
	return buildState(pull.checks ?? null);
}

/**
 * Is anything on this page still going to change on its own?
 *
 * The panel's tiered-poll signal, and deliberately the same shape as `anyBuildInFlight`. A settled
 * list of PRs with finished checks cannot change until somebody pushes or reviews — and every tick
 * spends GitHub's rate limit. #401's own self-review is explicit that the conditional request makes
 * a poll CHEAPER and is not a licence to poll more often, so the intervals here match the Builds
 * panel's exactly.
 */
export function anyPullInFlight(pulls: readonly PullRow[]): boolean {
	return pulls.some((p) => {
		const s = checksState(p);
		return s === "running" || s === "pending";
	});
}

/** "opened by your agent" / "merged by your agent" — the badge, when attribution is exact. */
export function agentActLabel(act: PullRow["agentAct"]): string | null {
	if (!act) return null;
	if (act.act === "pr.open") return "Opened by your agent";
	if (act.act === "pr.merge") return "Merged by your agent";
	return null;
}
