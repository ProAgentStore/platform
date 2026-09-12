import type { CodingRepo } from "./types";
import RepoSettingsModal from "./RepoSettingsModal";

/**
 * The repo settings sheet, for whichever repo is currently selected.
 *
 * The only thing here is the id -> repo resolution, and it is here rather than in CodingTab because
 * all three of that file's render branches end with this sheet: as a local it was an IIFE whose
 * `repos.find` had to be read past in each of them. A `repoId` naming a repo that is no longer in
 * the list renders nothing, which is the state right after a delete — the parent removes the row
 * and clears the selection, and those are two renders, not one.
 *
 * `onDelete` takes the id, so the caller does not need the resolved repo it would otherwise have to
 * look up a second time to build the callback.
 */
export default function SelectedRepoSettings({ repos, repoId, instanceId, onClose, onSaved, onDelete }: {
	repos: CodingRepo[];
	repoId: string | null;
	instanceId: string;
	onClose: () => void;
	onSaved: () => void;
	onDelete: (repoId: string) => void | Promise<void>;
}) {
	if (!repoId) return null;
	const repo = repos.find((r) => r.id === repoId);
	if (!repo) return null;
	return (
		<RepoSettingsModal repo={repo} instanceId={instanceId} onClose={onClose} onSaved={onSaved} onDelete={() => onDelete(repo.id)} />
	);
}
