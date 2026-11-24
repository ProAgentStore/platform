import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { Layers } from "lucide-react";
import LoadFailed from "./LoadFailed";
import { EXECUTION_LANES, type ExecutionCard, type ExecutionProjection, OUTCOME_LABEL, OWNER_LABEL, cardHref, groupExecutionCards, kindLabel } from "../lib/executionLanes";

const POLL_MS = 5000;

/** One card of the four-lane board: what it is, where it stands, what blocks it and who acts next. Presentational. */
export function ExecutionCardView({ instanceId, card }: { instanceId: string; card: ExecutionCard }) {
	const href = cardHref(instanceId, card);
	return (
		<div className="border border-line rounded-lg bg-panel p-2.5 text-sm flex flex-col gap-1.5" data-testid="execution-card" data-card-id={card.cardId}>
			<div className="flex items-center gap-1.5 flex-wrap text-2xs font-bold text-muted">
				<span>{kindLabel(card)}</span>
				{card.needsYou && <span className="text-warning border border-warning-line rounded-full px-1.5 py-0.5" data-testid="badge-needs-you">Needs you</span>}
				{card.waitingToResume && <span className="border border-line rounded-full px-1.5 py-0.5" data-testid="badge-waiting-to-resume">Waiting to resume</span>}
				{card.outcome && <span className="border border-line rounded-full px-1.5 py-0.5" data-testid="badge-outcome">{OUTCOME_LABEL[card.outcome]}</span>}
			</div>
			<div className="font-semibold break-words">{card.title}</div>
			{card.blocker && (
				<div className="text-xs text-muted break-words" data-testid="blocker">
					{card.blocker.what} · Next: {OWNER_LABEL[card.blocker.nextOwner]}
				</div>
			)}
			{card.waitingToResume && <div className="text-xs text-muted" data-testid="waiting-line">Your answer is recorded; waiting for the run to apply it.</div>}
			{href && (
				<Link to={href} className="inline-flex items-center min-h-6 text-xs underline self-start">
					Open
				</Link>
			)}
		</div>
	);
}

/** The four lanes, in order, each with its count and cards. Presentational, so the same render serves a test and the page. */
export function ExecutionLanesBoard({ instanceId, cards }: { instanceId: string; cards: readonly ExecutionCard[] }) {
	const byLane = groupExecutionCards(cards);
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3 items-start mb-4" data-testid="execution-lanes">
			{EXECUTION_LANES.map((lane) => (
				<div key={lane.id} className="border border-line rounded-xl bg-panel/55 min-h-[120px]" data-testid={`lane-${lane.id}`}>
					<div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
						<div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide">
							<span className="w-2.5 h-2.5 rounded-full" style={{ background: lane.color }} />
							{lane.title}
						</div>
						<span className="text-2xs text-muted border border-line rounded-full px-1.5 py-0.5 font-bold">{byLane[lane.id].length}</span>
					</div>
					<div className="flex flex-col gap-2 p-2.5">
						{byLane[lane.id].length === 0 ? <div className="text-center text-muted-soft text-sm py-4">None</div> : byLane[lane.id].map((c) => <ExecutionCardView key={c.cardId} instanceId={instanceId} card={c} />)}
					</div>
				</div>
			))}
		</div>
	);
}

/** The board's Lanes view (#1698): the server's shared projection, polled, shown in the four lanes. */
export function ExecutionLanesView({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<ExecutionProjection | null>(null);
	const [error, setError] = useState("");
	const load = useCallback(async () => {
		try {
			setData(await api<ExecutionProjection>(`/v1/instances/${instanceId}/board/projection`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
		const t = window.setInterval(() => void load(), POLL_MS);
		return () => window.clearInterval(t);
	}, [load]);
	if (error && !data) return <LoadFailed what="the lanes" detail={error} onRetry={load} />;
	if (!data) return null;
	return <ExecutionLanesBoard instanceId={instanceId} cards={data.cards} />;
}

/** The view toggle's button for the four lanes. */
export function LanesViewButton({ active, onClick }: { active: boolean; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} title="Runs and sessions by lane" aria-pressed={active} className={`flex items-center gap-1 px-2 py-1.5 text-xs font-bold ${active ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}>
			<Layers size={13} />
			<span className="hidden sm:inline">Lanes</span>
		</button>
	);
}
