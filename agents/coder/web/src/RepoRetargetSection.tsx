import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo } from "./types";
import { describeRetargetBlocker, retargetRequestBody, type RetargetDestination } from "./repo-retarget";
import Button from "./Button";

interface RetargetAudit {
	id: string;
	state: string;
	from: string;
	to: string;
	appliedAt: number | null;
}

interface RetargetPreview {
	ready: boolean;
	blockers: string[];
	originRemedy?: string;
	changes: Record<string, { from: unknown; to: unknown }>;
}

/**
 * "This repository was renamed on GitHub" — the console's parity with `POST …/retarget` (#1012).
 *
 * Preview first, always: Apply is only offered for the exact destination a clean preview checked.
 * The binding keeps its id, instructions, sessions and timeline; the history below shows every
 * earlier coordinate, so past work is never presented as work on the new name.
 */
export default function RepoRetargetSection({ repo, instanceId, onApplied }: { repo: CodingRepo; instanceId: string; onApplied: () => void }) {
	const [open, setOpen] = useState(false);
	const [dest, setDest] = useState<RetargetDestination>({ owner: (repo.githubRepo ?? "").split("/")[0] ?? "", name: "", githubId: repo.githubRepositoryId ? String(repo.githubRepositoryId) : "" });
	const [preview, setPreview] = useState<{ key: string; result: RetargetPreview } | null>(null);
	const [history, setHistory] = useState<RetargetAudit[]>([]);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
	const base = `/v1/instances/${instanceId}/coding/repos/${repo.id}`;

	useEffect(() => {
		if (!open) return;
		api<{ audits: RetargetAudit[] }>(`${base}/retargets`)
			.then((d) => setHistory(d.audits ?? []))
			.catch(() => {});
	}, [open, base]);

	if (!repo.githubRepo) return null;
	const key = JSON.stringify(dest);
	const edit = (patch: Partial<RetargetDestination>) => {
		setDest({ ...dest, ...patch });
		setNote(null);
	};

	const send = async (dryRun: boolean) => {
		const body = retargetRequestBody(repo, dest, dryRun);
		if (!body) {
			setNote({ kind: "error", text: "Enter the new owner, name and numeric GitHub repository id." });
			return;
		}
		setBusy(true);
		setNote(null);
		try {
			const res = await api<RetargetPreview & { ok?: boolean }>(`${base}/retarget`, { method: "POST", body: JSON.stringify(body) });
			if (dryRun) setPreview({ key, result: res });
			else {
				setPreview(null);
				setNote({ kind: "ok", text: `Now bound to ${body.destination.owner}/${body.destination.name}. History and instructions were kept.` });
				onApplied();
			}
		} catch (e) {
			setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
		}
		setBusy(false);
	};

	const current = preview?.key === key ? preview.result : null;
	return (
		<div className="border border-line rounded-lg p-3 mb-3">
			<button type="button" onClick={() => setOpen(!open)} className="text-xs font-bold text-muted hover:text-ink">
				{open ? "▾" : "▸"} Repository renamed on GitHub?
			</button>
			{open && (
				<div className="mt-2">
					<p className="text-xs text-muted-soft mb-2">
						Moves this binding to the same repository's new name and keeps its sessions, timeline and instructions. Your checkout's origin must already use the new
						name; nothing on your machine is changed. A different repository is added as a new repo instead.
					</p>
					<div className="grid grid-cols-2 gap-2 mb-1.5">
						<label htmlFor="repo-retarget-owner" className="sr-only">New owner</label>
						<input id="repo-retarget-owner" value={dest.owner} onChange={(e) => edit({ owner: e.target.value })} placeholder="New owner" spellCheck={false} autoCapitalize="off" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs font-mono" />
						<label htmlFor="repo-retarget-name" className="sr-only">New name</label>
						<input id="repo-retarget-name" value={dest.name} onChange={(e) => edit({ name: e.target.value })} placeholder="New name" spellCheck={false} autoCapitalize="off" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs font-mono" />
					</div>
					<label htmlFor="repo-retarget-id" className="sr-only">GitHub repository id</label>
					<input id="repo-retarget-id" value={dest.githubId} onChange={(e) => edit({ githubId: e.target.value })} placeholder="GitHub repository id (numeric)" inputMode="numeric" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs font-mono mb-2" />

					{current && (
						<div data-testid="repo-retarget-preview" className="text-xs mb-2 break-words">
							{Object.entries(current.changes).map(([field, c]) => (
								<div key={field} className="text-muted">
									{field}: <span className="font-mono">{String(c.from ?? "—")}</span> → <span className="font-mono">{String(c.to ?? "—")}</span>
								</div>
							))}
							{current.blockers.map((b) => (
								<p key={b} className="text-warning mt-1">{describeRetargetBlocker(b)}</p>
							))}
							{current.originRemedy && <p className="font-mono text-muted mt-1">{current.originRemedy}</p>}
						</div>
					)}
					{note && <p data-testid="repo-retarget-note" className={`text-xs mb-2 break-words ${note.kind === "error" ? "text-danger" : "text-success"}`}>{note.text}</p>}

					<div className="flex gap-2 justify-end">
						<Button size="md" onClick={() => send(true)} disabled={busy}>{busy ? "Checking…" : "Preview"}</Button>
						<Button variant="primary" size="md" onClick={() => send(false)} disabled={busy || !current?.ready}>Retarget</Button>
					</div>

					{history.length > 0 && (
						<div className="mt-3">
							<div className="text-2xs uppercase tracking-wide text-muted-soft mb-1">Earlier names</div>
							{history.map((h) => (
								<div key={h.id} className="text-xs text-muted font-mono break-words">
									{h.from} → {h.to} · {h.state}
									{h.appliedAt ? ` · ${new Date(h.appliedAt).toLocaleString()}` : ""}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
