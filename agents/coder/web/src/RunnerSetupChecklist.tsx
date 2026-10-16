import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import Button from "./Button";
import { type RunnerSetupAnswer, type RunnerSetupLink, githubConnectOwners, githubSyncSentence, runnerSetupView } from "./runner-setup-view";

const route = (link: RunnerSetupLink | null) => (link?.kind === "route" ? link.to : "/");

/**
 * What is left before this agent can work on the subscriber's own machine (#869) — the live
 * checklist from `GET /v1/instances/:id/runner-setup`, shown until every step is done.
 *
 * It fetches for itself rather than taking state from CodingTab: the answer is read nowhere else,
 * and the tab already owns enough polls. It re-reads when the tab's runner verdict flips, which is
 * the moment the first two steps change, and otherwise slowly while anything is left. A failed
 * read — including the 409 a non-coding agent gets — renders nothing: this card is guidance, and
 * the tab's own offline and repo notices still say what is wrong.
 */
/**
 * Connect GitHub (#1082): sync the account's GitHub App installations for the owners the checklist found
 * installed-but-not-authorized — the same `POST /v1/github/installations/sync` as Preferences → Connections →
 * Sync installations, and the same proof (an organisation needs your ACTIVE membership). Says per owner what
 * happened, and re-reads the checklist.
 */
function ConnectGithub({ owners, onDone }: { owners: string[]; onDone: () => void }) {
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const [lines, setLines] = useState<string[]>([]);
	const connect = async () => {
		setBusy(true);
		const out: string[] = [];
		for (const owner of owners) {
			try {
				const r = await api<{ orgs?: Array<{ account: string; result: string; reason?: string }> }>("/v1/github/installations/sync", { method: "POST", body: JSON.stringify({ owner }) });
				out.push(...(r.orgs?.length ? r.orgs.map(githubSyncSentence) : [`${owner}: nothing to connect.`]));
			} catch (e) {
				out.push(`${owner}: ${e instanceof Error ? e.message : "the sync failed"}`);
			}
		}
		setLines(out);
		setBusy(false);
		onDone();
	};
	return (
		<div className="mt-1 flex flex-col gap-1">
			<div className="flex flex-wrap gap-2 items-center">
				<Button size="sm" variant="primary" onClick={() => void connect()} disabled={busy}>
					{busy ? "Connecting…" : "Connect GitHub"}
				</Button>
				<button type="button" onClick={() => navigate("/preferences")} className="text-xs underline text-muted">Preferences → Connections</button>
			</div>
			{lines.map((l) => <p key={l} role="status" className="text-xs text-muted break-words">{l}</p>)}
		</div>
	);
}

/**
 * `compact` (#1082): with a coding session open the checklist is not shown, which hid a GitHub problem
 * exactly where the work is. Compact renders only GitHub access, and only while it is not working.
 */
export default function RunnerSetupChecklist({ instanceId, runnerOnline, compact = false }: { instanceId: string; runnerOnline: boolean | null; compact?: boolean }) {
	const navigate = useNavigate();
	const [answer, setAnswer] = useState<RunnerSetupAnswer | null>(null);

	const load = useCallback(async () => {
		try {
			setAnswer(await api<RunnerSetupAnswer>(`/v1/instances/${instanceId}/runner-setup`));
		} catch {
			setAnswer(null);
		}
	}, [instanceId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runnerOnline is the re-read trigger — the runner coming up or going down is when the first two steps change.
	useEffect(() => { void load(); }, [load, runnerOnline]);
	// Only while something is left: a finished setup has nothing to watch for.
	useTieredPolling(load, compact ? { activeMs: 60000, passiveMs: 120000 } : { activeMs: 15000, passiveMs: 60000 }, false, answer !== null && !answer.ready);

	const connectOwners = githubConnectOwners(answer);
	if (compact) {
		const github = answer?.steps?.find((s) => s.step === "github_app");
		if (!github || github.done || !github.owners?.length) return null;
		return (
			<section aria-label="GitHub access" data-testid="github-access-notice" className="bg-panel border border-warning-line rounded-lg p-2.5 m-2 text-xs">
				<p className="font-semibold">GitHub access is not working for this agent</p>
				<p className="text-muted break-words">{github.instruction}</p>
				{connectOwners.length > 0 && <ConnectGithub owners={connectOwners} onDone={() => void load()} />}
			</section>
		);
	}
	const view = runnerSetupView(answer, `/instances/${instanceId}/coding`);
	if (!view) return null;
	return (
		<section id="runner-setup-checklist" aria-labelledby="runner-setup-heading" className="bg-panel border border-line rounded-lg p-3 m-2 text-sm">
			<h2 id="runner-setup-heading" className="font-semibold">
				Set up your local runner <span className="text-muted font-normal">· {view.doneCount} of {view.total} done</span>
			</h2>
			<ol className="mt-2 flex flex-col gap-2">
				{view.rows.map((r) => (
					<li key={r.id} aria-current={r.current ? "step" : undefined} className="flex gap-2 items-start min-w-0">
						{r.done
							? <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" aria-hidden="true" />
							: <Circle size={16} className={`shrink-0 mt-0.5 ${r.current ? "text-accent" : "text-muted-soft"}`} aria-hidden="true" />}
						<div className="min-w-0">
							<div className={r.done ? "text-muted" : "font-semibold"}>
								{r.title}
								<span className="sr-only">{r.done ? " (done)" : " (not done)"}</span>
							</div>
							{/* Once a step is done its instruction is history; showing it keeps the list long on a phone. */}
							{/* `break-words`: instructions name whole shell commands, which overflow a 320px screen. */}
							{!r.done && <p className="text-xs text-muted break-words">{r.instruction}</p>}
							{!r.done && r.id === "github_app" && connectOwners.length > 0 && <ConnectGithub owners={connectOwners} onDone={() => void load()} />}
							{!r.done && r.link?.kind === "route" && (
								<button type="button" onClick={() => navigate(route(r.link))} className="text-xs underline font-semibold text-accent">
									Open<span className="sr-only">: {r.title}</span>
								</button>
							)}
							{!r.done && r.link?.kind === "external" && (
								<a href={r.link.href} target="_blank" rel="noopener noreferrer" className="text-xs underline font-semibold text-accent inline-flex items-center gap-1">
									Open<span className="sr-only">: {r.title} (opens in a new tab)</span> <ExternalLink size={11} aria-hidden="true" />
								</a>
							)}
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}
