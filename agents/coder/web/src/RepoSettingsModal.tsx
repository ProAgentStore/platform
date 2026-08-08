import { useState, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo } from "./types";
import { repoProviderLabel } from "./repo-title";
import { Settings, Trash2, Lock } from "lucide-react";

/**
 * Per-repo settings sheet: name, FOLDER, special instructions (rules), launch URLs, and delete.
 *
 * The Folder row used to be a `Detail` — a read-only div wearing this app's text-input costume
 * (same border, same radius, same `font-mono`; `bg-paper` vs `bg-panel` is #0a0a0a against #141414
 * on a dark-only theme, which is not a distinction anyone can see). An owner clicked it, typed a
 * corrected path into what they reasonably took for the field, saved, and the agent kept reading
 * the old directory — because there was no such field, and no PUT parameter behind it either
 * (#410/#411). It is a real input now, and `Detail` no longer imitates one.
 */
export default function RepoSettingsModal({ repo, instanceId, onClose, onSaved, onDelete }: {
	repo: CodingRepo;
	instanceId: string;
	onClose: () => void;
	onSaved: () => void;
	/** Delete this repo (confirmed here); the parent removes it and closes the sheet. */
	onDelete: () => void | Promise<void>;
}) {
	const [name, setName] = useState(repo.name);
	const [workdir, setWorkdir] = useState(repo.workdir || "");
	const [rules, setRules] = useState(repo.instructions || "");
	const [dev, setDev] = useState(repo.urls?.dev || "");
	const [staging, setStaging] = useState(repo.urls?.staging || "");
	const [prod, setProd] = useState(repo.urls?.prod || "");
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	/**
	 * What the server said about the folder, shown beside the field rather than in an `alert`.
	 * `warn` is a stored-but-unusable path (the save SUCCEEDED — see the route: an owner may be
	 * fixing this from a phone with the machine shut, so the value is kept and marked); `error` is
	 * a refusal (blank, or a session still running in the old directory).
	 */
	const [folderNote, setFolderNote] = useState<{ kind: "warn" | "error"; text: string } | null>(null);

	const del = async () => {
		if (!confirm(`Delete repo "${repo.name}"? This removes it from the agent.`)) return;
		setDeleting(true);
		try {
			await onDelete();
		} catch (e) {
			alert("Delete failed: " + (e instanceof Error ? e.message : String(e)));
			setDeleting(false);
		}
	};

	useEffect(() => {
		// Load the latest saved rules (the list may be stale).
		api<{ instructions: string }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}/instructions`)
			.then((d) => setRules(d.instructions || ""))
			.catch(() => {});
	}, [instanceId, repo.id]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const save = async () => {
		const folder = workdir.trim();
		// Caught here as well as on the server: blanking the address of a repo every tool addresses
		// BY it is a delete, and delete is the button next to this one.
		if (!folder && repo.workdir) {
			setFolderNote({ kind: "error", text: "A folder is required. To remove this repo, use Delete." });
			return;
		}
		setSaving(true);
		setFolderNote(null);
		try {
			const res = await api<{ warning?: string }>(`/v1/instances/${instanceId}/coding/repos/${repo.id}`, {
				method: "PUT",
				body: JSON.stringify({
					name: name.trim() || repo.name,
					urls: { dev: dev.trim(), staging: staging.trim(), prod: prod.trim() },
					// Only when it is set. An unchanged value is a no-op on the server (it compares
					// before it moves), so this costs nothing and keeps one payload shape.
					...(folder ? { workdir: folder } : {}),
				}),
			});
			await api(`/v1/instances/${instanceId}/coding/repos/${repo.id}/instructions`, {
				method: "PUT",
				body: JSON.stringify({ instructions: rules }),
			});
			repo.instructions = rules;
			onSaved();
			// A stored-but-unusable folder keeps the sheet OPEN with the server's own sentence under
			// the field. This is the moment the owner can act on it — closing on a warning would put
			// the diagnosis on a screen they have just left, which is how the empty directory in
			// #405 survived for two days.
			if (res?.warning) {
				setFolderNote({ kind: "warn", text: res.warning });
				setSaving(false);
				return;
			}
			onClose();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// The server's refusals are all ABOUT the folder (blank, or a live session in the old
			// directory), so they belong beside it rather than in an alert box.
			if (/folder|session is running/i.test(msg)) setFolderNote({ kind: "error", text: msg });
			else alert("Save failed: " + msg);
		}
		setSaving(false);
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85dvh] overflow-y-auto overscroll-contain p-4" style={{ WebkitOverflowScrolling: "touch" }}>
				<div className="flex items-center justify-between gap-3 mb-3">
					<h3 className="text-base font-bold flex items-center gap-1.5"><Settings size={16} /> Repo settings</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">✕</button>
				</div>

				<label htmlFor="repo-settings-name" className="block text-xs font-bold text-muted mb-1">Name</label>
				<input id="repo-settings-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm mb-3" />

				{/* The ADDRESS — editable, because a checkout moves and the platform must be able to
				    follow it (#410/#411). The repo's IDENTITY stays fixed: sessions and the timeline
				    hang off this row, which is why correcting a path must not mean deleting it. */}
				<label htmlFor="repo-settings-workdir" className="block text-xs font-bold text-muted mb-1">Folder on your machine</label>
				<input
					id="repo-settings-workdir"
					value={workdir}
					onChange={(e) => { setWorkdir(e.target.value); setFolderNote(null); }}
					placeholder="~/dev/my-repo"
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm font-mono mb-1"
				/>
				{folderNote ? (
					<p
						data-testid="repo-settings-folder-note"
						className={`text-xs mb-3 break-words ${folderNote.kind === "error" ? "text-red" : "text-yellow"}`}
					>
						{folderNote.text}
					</p>
				) : (
					<p className="text-xs text-muted-soft mb-3">Checked on your connected machine when you save.</p>
				)}

				{/* Read-only details */}
				<div className="grid grid-cols-2 gap-2 mb-3">
					{/* The HOST, not "GitHub" (#221) — this panel is where an owner checks what a repo
					    actually is, and it answered "GitHub or nothing" for every provider. */}
					{repo.repoSlug || repo.githubRepo ? (
						<Detail label={repoProviderLabel(repo.provider ?? (repo.githubRepo ? "github" : null))} value={repo.repoSlug || repo.githubRepo || ""} />
					) : null}
					{repo.cloneStatus && <Detail label="Clone status" value={repo.cloneStatus} />}
					<Detail label="Repo id" value={repo.id} />
				</div>

				<label htmlFor="repo-settings-rules" className="block text-xs font-bold text-muted mb-1">Special instructions (rules for this repo)</label>
				<textarea
					id="repo-settings-rules"
					value={rules}
					onChange={(e) => setRules(e.target.value)}
					placeholder="e.g. Always create feature branches. Never push to main. Use conventional commits. Run tests before committing."
					className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs min-h-[90px] resize-y mb-3"
					rows={4}
				/>

				<div className="text-xs font-bold text-muted mb-1">Launch URLs (optional)</div>
				<label htmlFor="repo-settings-dev-url" className="sr-only">Dev URL</label>
				<input id="repo-settings-dev-url" value={dev} onChange={(e) => setDev(e.target.value)} placeholder="Dev URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs mb-1.5" />
				<label htmlFor="repo-settings-staging-url" className="sr-only">Staging URL</label>
				<input id="repo-settings-staging-url" value={staging} onChange={(e) => setStaging(e.target.value)} placeholder="Staging URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs mb-1.5" />
				<label htmlFor="repo-settings-production-url" className="sr-only">Production URL</label>
				<input id="repo-settings-production-url" value={prod} onChange={(e) => setProd(e.target.value)} placeholder="Production URL" className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-xs" />

				<div className="flex gap-2 justify-between items-center mt-4">
					<button type="button" onClick={del} disabled={deleting || saving} className="text-xs px-3 py-1.5 rounded-md text-red font-semibold hover:bg-red/10 disabled:opacity-50 flex items-center gap-1"><Trash2 size={13} />{deleting ? "Deleting…" : "Delete"}</button>
					<div className="flex gap-2">
						<button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted font-semibold">Cancel</button>
						<button type="button" onClick={save} disabled={saving || deleting} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * A value you can READ, and a value you can CHANGE, must not look the same (#410).
 *
 * This used to render `bg-paper border border-line rounded-lg p-2` with a `font-mono` value —
 * which is the text-input costume two components away (`bg-panel border border-line rounded-xl
 * px-3 py-2`, and `font-mono` is what this console reserves for path/command INPUTS). The only
 * difference was #0a0a0a against #141414 on a dark-only theme. So a static label sat in a sheet
 * whose neighbouring controls are real fields, invited a click, did nothing, and read as the app
 * being broken rather than as the value being fixed.
 *
 * No box, no border, dimmer text, and a padlock: three signals, none of which an input has.
 */
function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0 py-1">
			<div className="text-2xs uppercase tracking-wide text-muted-soft mb-0.5 flex items-center gap-1">
				<Lock size={9} aria-hidden="true" />
				{label}
			</div>
			<div className="text-xs text-muted break-words font-mono">{value}</div>
		</div>
	);
}
