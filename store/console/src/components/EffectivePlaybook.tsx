import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import LoadFailed from "./LoadFailed";

/**
 * The effective Repo Coder playbook, read-only (#1692, #1691): the free-text Instructions the engine is actually given for one
 * registered repo, layer by layer. It is the same resolver the Pilot, the co-pilot and the direct turn use, so this shows what
 * will be delivered rather than a second opinion about it. Editing stays where it was: the template layer is the provider's
 * (not editable yet), the instance layer is the Special Instructions above, the repo layer is the repo's own Instructions.
 *
 * These are guidance, never permission: nothing here grants a capability or changes merge/question policy, approvals or checks.
 */
interface Layer {
	source: "template" | "instance" | "repo";
	text: string;
}
interface Playbook {
	layers: Layer[];
	empty: boolean;
}
interface Repo {
	id: string;
	name: string;
}

const LABEL: Record<Layer["source"], string> = {
	template: "Template defaults (the provider's)",
	instance: "Your Special Instructions (this agent, every repo)",
	repo: "This repository's Instructions",
};

export default function EffectivePlaybook({ instanceId }: { instanceId: string }) {
	const [repos, setRepos] = useState<Repo[] | null>(null);
	const [repoId, setRepoId] = useState("");
	const [playbook, setPlaybook] = useState<Playbook | null>(null);
	const [err, setErr] = useState("");

	const loadRepos = useCallback(async () => {
		try {
			const d = await api<Repo[] | { repos: Repo[] }>(`/v1/instances/${instanceId}/coding/repos`);
			const list = Array.isArray(d) ? d : d.repos;
			setRepos(list);
			setRepoId((cur) => cur || list[0]?.id || "");
			setErr("");
		} catch (e) {
			setErr(e instanceof Error ? e.message : "request failed");
		}
	}, [instanceId]);

	const loadPlaybook = useCallback(async () => {
		if (!repoId) return;
		try {
			setPlaybook(await api<Playbook>(`/v1/instances/${instanceId}/coding/repos/${repoId}/playbook`));
			setErr("");
		} catch (e) {
			setPlaybook(null);
			setErr(e instanceof Error ? e.message : "request failed");
		}
	}, [instanceId, repoId]);

	useEffect(() => {
		void loadRepos();
	}, [loadRepos]);
	useEffect(() => {
		void loadPlaybook();
	}, [loadPlaybook]);

	if (err) return <LoadFailed compact what="the effective playbook" detail={err} onRetry={() => void (repos ? loadPlaybook() : loadRepos())} testId="playbook-load-failed" />;
	if (!repos?.length) return null;

	return (
		<div className="mt-6" data-testid="effective-playbook">
			<h3 className="text-base font-bold mb-1">Effective playbook</h3>
			<p className="text-xs text-muted mb-2">
				What the coder is given for a repository, lowest precedence first; a later layer wins where two disagree. Guidance only: it never grants a capability or changes merge, question or approval settings.
			</p>
			{repos.length > 1 && (
				<select value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository" className="mb-2 text-sm">
					{repos.map((r) => (
						<option key={r.id} value={r.id}>
							{r.name}
						</option>
					))}
				</select>
			)}
			{playbook?.empty ? (
				<p className="text-xs text-muted-soft">No instructions at any layer, so the coder gets nothing beyond its own defaults.</p>
			) : (
				playbook?.layers.map((l) => (
					<div key={l.source} className="mb-2">
						<div className="text-xs font-semibold">{LABEL[l.source]}</div>
						<pre className="text-xs text-muted whitespace-pre-wrap break-words">{l.text}</pre>
					</div>
				))
			)}
		</div>
	);
}
