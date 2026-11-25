import { api } from "@proagentstore/sdk/client";

/**
 * The owner's deliberate endings for a coding run: abandon it, discard its isolated worktree (#1709), and publish the worktree of a run
 * they ended by hand (#1717). All are the owner's own routes; discard and publish preview on the machine first and execute only with the
 * head that preview returned.
 */

/** `GET /coding/sessions`, the fields the discard addresses a session by. */
interface SessionList {
	sessions?: Array<{ id: string; repoId: string; runnerNode?: string | null }>;
}

export interface DiscardPreview {
	result?: { ok?: boolean; reason?: string; error?: string; head?: string; files?: number; changed?: string[]; pinRef?: string; pinned?: string | null; discardedFiles?: number; recovery?: string };
	error?: string;
}

/** What the confirmation shows: how many files go, which, and what stays recoverable. Pure. */
export function discardPrompt(files: number, changed: string[], pinRef: string): string {
	const list = changed.slice(0, 15).join("\n");
	const more = files > changed.length ? `\n…and ${files - changed.length} more` : "";
	return `Discard this run's isolated worktree?\n\n${files} uncommitted file${files === 1 ? "" : "s"} will be deleted and cannot be recovered:\n${list}${more}\n\nNothing is committed. A commit that exists only in that worktree is kept on ${pinRef}.`;
}

export async function abandonRun(instanceId: string, runId: string): Promise<void> {
	await api(`/v1/instances/${instanceId}/coding/runs/${encodeURIComponent(runId)}/abandon`, { method: "POST", body: JSON.stringify({}) });
}

/** Returns a message for the owner: what was removed, or why nothing was. Null when the owner declined. */
export async function discardRunWorktree(instanceId: string, sessionId: string, confirmFn: (text: string) => boolean): Promise<string | null> {
	const { sessions } = await api<SessionList>(`/v1/instances/${instanceId}/coding/sessions`);
	const session = (sessions ?? []).find((s) => s.id === sessionId);
	if (!session) return "That session is no longer listed, so its worktree cannot be addressed from here.";
	if (!session.runnerNode) return "That session is not stamped to a machine, so there is no worktree to discard.";
	const base = `/v1/instances/${instanceId}/coding/repos/${encodeURIComponent(session.repoId)}/worktrees/discard`;
	let preview: DiscardPreview;
	try {
		preview = await api<DiscardPreview>(`${base}?runner_node=${encodeURIComponent(session.runnerNode)}&session_id=${encodeURIComponent(sessionId)}`);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	const p = preview.result;
	if (!p?.ok || !p.head) return p?.error ?? preview.error ?? "The machine could not preview the discard; nothing was changed.";
	if (!confirmFn(discardPrompt(p.files ?? 0, p.changed ?? [], p.pinRef ?? ""))) return null;
	try {
		const done = await api<DiscardPreview>(base, { method: "POST", body: JSON.stringify({ runner_node: session.runnerNode, session_id: sessionId, dry_run: false, expected_head: p.head }) });
		return done.result?.ok ? `Worktree discarded (${done.result.discardedFiles ?? 0} file${done.result.discardedFiles === 1 ? "" : "s"}).${done.result.pinned ? ` Committed work kept on ${done.result.pinned}.` : ""}` : (done.result?.error ?? "The machine did not discard it.");
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

export interface PublishPreview {
	result?: { ok?: boolean; reason?: string; error?: string; head?: string; mode?: "direct" | "pr"; target?: string; branch?: string | null; commits?: number | null; uncommittedFiles?: number; uncommitted?: string[]; published?: boolean };
	error?: string;
}

export interface PublishDone {
	ok?: boolean;
	line?: string;
	error?: string;
}

/** What the confirmation shows: where it goes, how many commits, and what will NOT be published. Pure. */
export function publishPrompt(p: NonNullable<PublishPreview["result"]>): string {
	const commits = typeof p.commits === "number" ? `${p.commits} commit${p.commits === 1 ? "" : "s"}` : "this run's commits";
	const where = p.mode === "pr" ? `Push ${commits} to the branch ${p.branch ?? "(run branch)"} and open a pull request into ${p.target}. Nothing is pushed to ${p.target} itself.` : `Push ${commits} to ${p.target} (a plain push, never forced, read back from the remote).`;
	const left = p.uncommittedFiles ? `\n\n${p.uncommittedFiles} uncommitted file${p.uncommittedFiles === 1 ? "" : "s"} will NOT be published and keep the checkout in place:\n${(p.uncommitted ?? []).slice(0, 15).join("\n")}` : "";
	return `Publish this run's isolated worktree?\n\n${where}${left}\n\nThe worktree is removed only after the publication reads back.`;
}

/** Returns a message for the owner: what was published, or why nothing was. Null when the owner declined. */
export async function publishRunWorktree(instanceId: string, sessionId: string, confirmFn: (text: string) => boolean): Promise<string | null> {
	const { sessions } = await api<SessionList>(`/v1/instances/${instanceId}/coding/sessions`);
	const session = (sessions ?? []).find((s) => s.id === sessionId);
	if (!session) return "That session is no longer listed, so its worktree cannot be addressed from here.";
	if (!session.runnerNode) return "That session is not stamped to a machine, so there is no worktree to publish.";
	const base = `/v1/instances/${instanceId}/coding/repos/${encodeURIComponent(session.repoId)}/worktrees/publish`;
	let preview: PublishPreview;
	try {
		preview = await api<PublishPreview>(`${base}?runner_node=${encodeURIComponent(session.runnerNode)}&session_id=${encodeURIComponent(sessionId)}`);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	const p = preview.result;
	if (!p?.ok || !p.head) return p?.error ?? preview.error ?? "The machine could not preview the publication; nothing was changed.";
	if (p.published) return "This run's commits are already on the remote; nothing to publish.";
	if (!confirmFn(publishPrompt(p))) return null;
	try {
		const done = await api<PublishDone>(base, { method: "POST", body: JSON.stringify({ runner_node: session.runnerNode, session_id: sessionId, dry_run: false, expected_head: p.head }) });
		return done.line ?? (done.ok ? "Published." : (done.error ?? "The machine did not publish it."));
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}
