/**
 * Folder-sync traversal and import decisions (#20).
 *
 * Two problems, both invisible until a real client folder hits them:
 *
 *  1. **Shallow.** The sync listed one folder and threw away every subfolder it found, so a
 *     nested structure — which is what real Drive/WorkDrive folders look like — silently synced
 *     only its top level. Nothing reported the omission; the trigger said "imported 3 files" and
 *     looked healthy.
 *
 *  2. **Duplicates.** `agent_trigger_sync_state` has recorded `imported_doc_id` since it was
 *     created, but nothing ever READ it: every changed file was POSTed as a NEW knowledge doc
 *     and the state row was overwritten to point at it, orphaning the previous copy. A document
 *     edited weekly therefore accumulated a copy per edit, and the agent retrieved all of them —
 *     several versions of the same page, with nothing marking which was current. The 20-doc KB
 *     cap makes this worse than untidy: a handful of edits can exhaust the whole knowledge base.
 *
 * The traversal is a bounded breadth-first walk with the IO injected, so the limits are testable
 * against a fake tree rather than against a provider. Grant enforcement is by CONSTRUCTION: the
 * walk only ever starts at the granted root and only ever descends into folders it found inside
 * it, so every descendant reached is inside the grant. No descendant needs re-checking, and no
 * caller can pass a folder in from outside.
 */

/** Deepest nesting a sync will walk. Depth 0 = the root folder itself. */
export const SYNC_MAX_DEPTH = 10;
/** Default depth when a sync asks for recursion without naming one. */
export const SYNC_DEFAULT_DEPTH = 3;
/** Most folders one sync will LIST. The hard stop on provider calls, and so on cron runtime. */
export const SYNC_MAX_FOLDERS = 50;
/** Most candidate files one sync will collect before it stops looking. */
export const SYNC_MAX_FILES = 500;

export interface TraversalLimits {
	maxDepth: number;
	maxFolders: number;
	maxFiles: number;
}

/**
 * Resolve the limits for one sync.
 *
 * Non-recursive stays EXACTLY what it was — depth 0, one folder listed — so every existing
 * trigger behaves identically after this change. Recursion is opt-in per trigger.
 */
export function resolveTraversalLimits(config: { recursive?: boolean; maxDepth?: number }): TraversalLimits {
	if (!config.recursive) return { maxDepth: 0, maxFolders: 1, maxFiles: SYNC_MAX_FILES };
	const raw = config.maxDepth;
	const depth = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : SYNC_DEFAULT_DEPTH;
	return {
		maxDepth: Math.max(0, Math.min(depth, SYNC_MAX_DEPTH)),
		maxFolders: SYNC_MAX_FOLDERS,
		maxFiles: SYNC_MAX_FILES,
	};
}

/** The minimum a traversal needs to know about a provider's node. */
export interface TraversalNode {
	id: string;
	isFolder: boolean;
}

export interface TraversalResult<T> {
	/** Non-folder nodes found, in breadth-first order. */
	files: T[];
	/** How many folders were actually listed (includes the root). */
	foldersScanned: number;
	/** True when a limit stopped the walk early — so the caller can say so instead of implying completeness. */
	truncated: boolean;
	/** Folders whose listing failed, by id. A permission hole in one subtree must not fail the sync. */
	errors: { folderId: string; message: string }[];
}

/**
 * Bounded breadth-first walk from `rootId`.
 *
 * Breadth-first rather than depth-first on purpose: when a limit truncates the walk, what has
 * been collected is the shallowest — i.e. the files nearest the folder the user actually pointed
 * at — rather than an arbitrary deep branch.
 *
 * A cycle (Drive shortcuts, WorkDrive links) cannot loop the walk: every folder id is visited at
 * most once.
 */
export async function walkFolderTree<T extends TraversalNode>(
	rootId: string,
	listFolder: (folderId: string) => Promise<T[]>,
	limits: TraversalLimits,
): Promise<TraversalResult<T>> {
	const files: T[] = [];
	const errors: { folderId: string; message: string }[] = [];
	const visited = new Set<string>();
	let queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
	let foldersScanned = 0;
	let truncated = false;

	while (queue.length) {
		const next: { id: string; depth: number }[] = [];
		for (const { id, depth } of queue) {
			if (visited.has(id)) continue;
			if (foldersScanned >= limits.maxFolders) {
				truncated = true;
				return { files, foldersScanned, truncated, errors };
			}
			visited.add(id);
			foldersScanned++;

			let children: T[];
			try {
				children = await listFolder(id);
			} catch (err) {
				errors.push({ folderId: id, message: err instanceof Error ? err.message : String(err) });
				continue;
			}

			for (const child of children) {
				if (child.isFolder) {
					// Only queue a subfolder we are still allowed to descend into, so a deep tree
					// costs nothing beyond the depth the user asked for.
					if (depth < limits.maxDepth && !visited.has(child.id)) next.push({ id: child.id, depth: depth + 1 });
					continue;
				}
				if (files.length >= limits.maxFiles) {
					truncated = true;
					return { files, foldersScanned, truncated, errors };
				}
				files.push(child);
			}
		}
		queue = next;
	}
	return { files, foldersScanned, truncated, errors };
}

// ── import decisions ─────────────────────────────────────────────────────────

/** What the sync should do with one file it found. */
export type SyncAction = "skip" | "import" | "update";

/** The recorded state of a previously-synced source file, or null when it is new to this trigger. */
export interface PriorSyncState {
	fingerprint: string;
	importedDocId: string | null;
}

/**
 * Decide what to do with one source file.
 *
 *  • no prior state              → import (never seen)
 *  • fingerprint unchanged       → skip (the existing cheap no-op)
 *  • changed, doc id known       → UPDATE that doc in place — the fix for the duplicate bug
 *  • changed, no doc id recorded → import (the previous import failed, or predates the column)
 *
 * `versioned` restores the old create-a-new-doc behaviour for a user who genuinely wants a
 * history. It is opt-in precisely because the ticket's acceptance is "changed source files do not
 * create confusing duplicates UNLESS versioning is explicitly chosen".
 */
export function syncDecision(prior: PriorSyncState | null, fingerprint: string, versioned = false): SyncAction {
	if (!prior) return "import";
	if (prior.fingerprint === fingerprint) return "skip";
	if (versioned) return "import";
	return prior.importedDocId ? "update" : "import";
}

/**
 * Title for a versioned re-import, so the copies are at least ordered and distinguishable
 * instead of N identical titles.
 */
export function versionedTitle(title: string, at: Date): string {
	const stamp = at.toISOString().slice(0, 16).replace("T", " ");
	return `${title} (${stamp})`.slice(0, 500);
}

/** Counts one sync run reports. `updated` is new (#20): it was previously invisible inside `imported`. */
export interface SyncCounts {
	scanned: number;
	imported: number;
	updated: number;
	skipped: number;
	foldersScanned: number;
	truncated: boolean;
}

/**
 * One line describing a sync outcome. Mentions truncation explicitly — a partial sync that reads
 * as complete is how someone concludes the agent has documents it has never seen.
 */
export function describeSync(counts: SyncCounts, errorCount = 0): string {
	const parts = [`imported ${counts.imported}`, `updated ${counts.updated}`, `skipped ${counts.skipped}`];
	let out = `connector sync ${parts.join(", ")} of ${counts.scanned} file(s) across ${counts.foldersScanned} folder(s)`;
	if (errorCount) out += `, ${errorCount} error(s)`;
	if (counts.truncated) out += " — stopped at the traversal limit, so some files were not examined";
	return out;
}
