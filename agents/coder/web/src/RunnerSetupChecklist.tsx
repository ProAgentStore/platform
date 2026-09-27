import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { type RunnerSetupAnswer, type RunnerSetupLink, runnerSetupView } from "./runner-setup-view";

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
export default function RunnerSetupChecklist({ instanceId, runnerOnline }: { instanceId: string; runnerOnline: boolean | null }) {
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
	useTieredPolling(load, { activeMs: 15000, passiveMs: 60000 }, false, answer !== null && !answer.ready);

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
