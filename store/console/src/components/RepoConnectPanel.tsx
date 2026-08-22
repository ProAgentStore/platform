import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";

/**
 * Connect a repository — the ONE-TIME act, which is why it is on Settings and not on the Repo tab
 * (#727).
 *
 * The owner's rule: *"one-time action to connect to repo or save it is in settings. repo
 * management (once connected) — separate tab."* Adding a repo you do not have is setup; everything
 * you do to one you already have — progress, re-index, remove, the file list — is operation, and
 * stays where it is.
 *
 * The precedent is one level up: `AccountConnections` puts *connect* on Preferences, which is the
 * account-wide settings surface, because connecting Gmail is an account fact. A repository is a
 * PER-INSTANCE fact — each Repo Chat instance indexes its own — so the instance Settings tab is
 * the same decision at the level where the fact lives, rather than a new pattern.
 *
 * This is the only place the form exists. Rendering it here AND on the Repo tab would put two
 * surfaces on one piece of state, which is a defect class this backlog already carries several of;
 * it is also why the panel does not list what is already indexed. It cannot show progress either —
 * that needs the status poll, which belongs to the tab that owns the list — so it says where the
 * progress is instead of implying there is none.
 */
export interface RepoConnectPanelProps {
	instanceId: string;
}

export default function RepoConnectPanel({ instanceId }: RepoConnectPanelProps) {
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [msg, setMsg] = useState("");

	const connect = async () => {
		const repoUrl = url.trim();
		if (!repoUrl) return;
		setBusy(true);
		setErr("");
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/ingest-repo`, { method: "POST", body: JSON.stringify({ repoUrl }) });
			setUrl("");
			setMsg("Indexing started — watch it finish on the Repo tab.");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1" id="repo-connect-label">Repositories</h3>
			<p className="text-sm text-muted mb-3">
				Paste any GitHub URL. I'll read the whole codebase into my knowledge base, then you can ask
				about it in the Assistant tab — by text or voice. You can index several repos and chat across
				all of them. Read-only: I explain, I never change your code.
			</p>
			<div className="flex gap-2">
				{/* The heading IS this field's label, the same association the Instance name field
				    above uses — a screen reader announces the words a sighted user reads. */}
				<input
					aria-labelledby="repo-connect-label"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
					placeholder="https://github.com/owner/repo"
					className="flex-1 min-w-0"
				/>
				<Button variant="primary" size="lg" onClick={() => void connect()} disabled={busy || !url.trim()} className="shrink-0">
					{busy ? "…" : "Index"}
				</Button>
			</div>
			{err && <p className="text-xs text-danger mt-2" data-testid="repo-connect-error">{err}</p>}
			{msg && <p className="text-xs text-success mt-2">{msg}</p>}
			<p className="text-xs text-muted-soft mt-2">Public repos work as-is. Private repos need GitHub connected. Up to 20 repos, 300 files each.</p>
			<p className="text-xs text-muted-soft mt-1">Progress, re-index and remove live on the <b>Repo</b> tab.</p>
		</Card>
	);
}
