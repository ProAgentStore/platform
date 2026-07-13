import { useState, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import type { CodingRepo } from "./types";
import { Settings } from "lucide-react";

/** Per-repo settings sheet: name, special instructions (rules), and launch URLs. */
export default function RepoSettingsModal({ repo, instanceId, onClose, onSaved }: {
	repo: CodingRepo;
	instanceId: string;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(repo.name);
	const [rules, setRules] = useState(repo.instructions || "");
	const [dev, setDev] = useState(repo.urls?.dev || "");
	const [staging, setStaging] = useState(repo.urls?.staging || "");
	const [prod, setProd] = useState(repo.urls?.prod || "");
	const [saving, setSaving] = useState(false);

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
		setSaving(true);
		try {
			await api(`/v1/instances/${instanceId}/coding/repos/${repo.id}`, {
				method: "PUT",
				body: JSON.stringify({ name: name.trim() || repo.name, urls: { dev: dev.trim(), staging: staging.trim(), prod: prod.trim() } }),
			});
			await api(`/v1/instances/${instanceId}/coding/repos/${repo.id}/instructions`, {
				method: "PUT",
				body: JSON.stringify({ instructions: rules }),
			});
			repo.instructions = rules;
			onSaved();
			onClose();
		} catch (e) {
			alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
		}
		setSaving(false);
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-xl sm:rounded-xl w-full sm:max-w-lg max-h-[88vh] overflow-auto p-4">
				<div className="flex items-center justify-between gap-3 mb-3">
					<h3 className="text-base font-bold flex items-center gap-1.5"><Settings size={16} /> Repo settings</h3>
					<button type="button" onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">✕</button>
				</div>

				<label htmlFor="repo-settings-name" className="block text-xs font-bold text-muted mb-1">Name</label>
				<input id="repo-settings-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm mb-3" />

				{/* Read-only details */}
				<div className="grid grid-cols-2 gap-2 mb-3">
					{repo.githubRepo && <Detail label="GitHub" value={repo.githubRepo} />}
					{repo.workdir && <Detail label="Folder" value={repo.workdir} />}
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

				<div className="flex gap-2 justify-end mt-4">
					<button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-line text-muted font-semibold">Cancel</button>
					<button type="button" onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-bold disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
				</div>
			</div>
		</div>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-paper border border-line rounded-lg p-2 min-w-0">
			<div className="text-[0.6rem] uppercase tracking-wide text-muted-soft mb-0.5">{label}</div>
			<div className="text-xs text-ink break-words font-mono">{value}</div>
		</div>
	);
}
