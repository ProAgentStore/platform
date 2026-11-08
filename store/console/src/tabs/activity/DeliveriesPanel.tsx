import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { formatTime } from "@proagentstore/sdk/ui";
import { plainMarkdown } from "../../lib/agentText";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { deliveryCounts, deliveryHeadline, describeDelivery, toneClass, type Delivery } from "../../lib/teamwork";
import { type PanelProps, useReport } from "./useReport";

/**
 * Activity → History → the Teamwork delivery log (the outbox made visible; moved from Settings → Automation in #1590).
 * Retry with backoff, dead-lettering, replay and trace correlation are worthless if the only way to see a
 * stalled chain is a curl against a status filter you had to know existed. The rules that turn a row into a
 * sentence are pure and tested in ../../lib/teamwork.ts.
 */

type Instance = { id: string; name?: string; slug?: string; agentName?: string };
type TraceEvent = { id?: string; ts?: string; event?: string; message?: string; source?: string; level?: string };

/** Status filters over the delivery log. "Undelivered" leads because it is the only one that needs a human. */
const DELIVERY_VIEWS = [
	{ id: "dead", label: "Undelivered" },
	{ id: "pending", label: "Retrying" },
	{ id: "delivered", label: "Delivered" },
	{ id: "all", label: "All" },
] as const;
type DeliveryView = (typeof DELIVERY_VIEWS)[number]["id"];

export default function DeliveriesPanel({ instanceId, onReport, focused }: PanelProps & { focused: boolean }) {
	const [instances, setInstances] = useState<Instance[]>([]);
	const [deliveries, setDeliveries] = useState<Delivery[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState("");
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [view, setView] = useState<DeliveryView>("dead");
	const [open, setOpen] = useState<boolean | null>(null);
	const [openTrace, setOpenTrace] = useState<string | null>(null);
	const [trace, setTrace] = useState<TraceEvent[] | null>(null);

	// Only the deliveries: Replay must not refetch anything else.
	const loadDeliveries = useCallback(async () => {
		try {
			// EVERY status, not just dead: the headline is a statement about what the connections HAVE carried.
			const d = await api<{ deliveries: Delivery[] }>(`/v1/instances/${instanceId}/connections/deliveries?limit=200`);
			setDeliveries(d.deliveries ?? []);
			setLoaded(true);
			setFailed("");
		} catch (e) {
			setFailed(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => {
		void loadDeliveries();
		api<{ instances: Instance[] }>("/v1/instances/my/instances").then((r) => setInstances(r.instances ?? [])).catch(() => undefined);
	}, [loadDeliveries]);

	const nameOf = (id: string) => {
		const i = instances.find((x) => x.id === id);
		return i?.name || i?.agentName || i?.slug || id;
	};
	const counts = useMemo(() => deliveryCounts(deliveries), [deliveries]);
	const headline = deliveryHeadline(counts);
	const shown = useMemo(() => (view === "all" ? deliveries : deliveries.filter((d) => d.status === view)), [deliveries, view]);
	useReport("deliveries", onReport, loaded ? "ready" : failed ? "failed" : "loading", deliveries.length, false);

	const replay = async (id: string) => {
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/connections/deliveries/${id}/replay`, { method: "POST" });
			await loadDeliveries();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	/**
	 * Follow one delivery's correlation id into the run it started. The emitting run's id rides on the delivery
	 * and into the child run, and `chain.link` is logged under the PARENT trace — so this trace read is what
	 * joins two agents' runs into one story.
	 */
	const toggleTrace = async (d: Delivery) => {
		if (openTrace === d.id) {
			setOpenTrace(null);
			return;
		}
		setOpenTrace(d.id);
		setTrace(null);
		if (!d.traceId) return;
		try {
			const r = await api<{ events: TraceEvent[] }>(`/v1/instances/${d.sourceInstanceId || instanceId}/trace?trace_id=${encodeURIComponent(d.traceId)}&limit=50`);
			setTrace(r.events ?? []);
		} catch {
			setTrace([]);
		}
	};

	if (!loaded) return failed ? <LoadFailed what="the delivery log" detail={failed} onRetry={() => void loadDeliveries()} testId="history-failed-deliveries" compact /> : null;
	if (deliveries.length === 0) return null;
	const showLog = open ?? (counts.dead > 0 || focused);

	return (
		<Card className="mb-3 sm:mb-4" data-testid="history-deliveries">
			<h3 className="text-base font-bold mb-1">Event deliveries</h3>
			<div className="flex items-center flex-wrap gap-2 mb-2">
				<button type="button" onClick={() => setOpen(!showLog)} className="text-sm font-semibold underline decoration-dotted min-h-6">
					{showLog ? "Hide" : "Show"} delivery log
				</button>
				<span className={`text-xs ${toneClass(headline.tone)}`}>{headline.text}</span>
			</div>
			{showLog && (
				<div>
					<div className="flex flex-wrap gap-1 mb-2">
						{DELIVERY_VIEWS.map((v) => {
							const n = v.id === "all" ? counts.total : counts[v.id];
							return (
								<button
									key={v.id}
									type="button"
									onClick={() => setView(v.id)}
									className={`text-xs px-2 py-1 rounded-lg border min-h-6 ${view === v.id ? "border-accent text-accent" : "border-line text-muted"}`}
								>
									{v.label} {n}
								</button>
							);
						})}
					</div>
					{shown.length === 0 && <div className="text-xs text-muted">{view === "dead" ? "Nothing stuck — every event reached its agent." : "Nothing here."}</div>}
					{shown.map((d) => {
						const state = describeDelivery(d);
						return (
							<div key={d.id} className="text-sm border border-line rounded-lg px-3 py-2 mb-1" data-testid="delivery-row">
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<div className="truncate">
											<code className="text-xs">{d.eventType || "event"}</code>
											<span className="text-muted text-xs">
												{" "}
												{nameOf(d.sourceInstanceId || instanceId)} → {nameOf(d.targetInstanceId || "")}
												{d.action ? ` · ${d.action}` : ""}
												{/* The outbox is shared with triggers (#17): a stuck trigger and a stuck connection are the same mechanism but not the same problem. */}
												{d.source === "trigger" ? " · via trigger" : ""}
											</span>
										</div>
										<div className={`text-2xs ${toneClass(state.tone)}`}>
											{state.text}
											{d.createdAt ? ` · ${formatTime(d.createdAt)}` : ""}
										</div>
										{d.lastError && <div className="text-2xs text-danger break-words">{d.lastError}</div>}
									</div>
									<div className="flex flex-col gap-1 shrink-0">
										{/* Retries wait out someone else's outage; when it is over, replay is the fix. */}
										{d.status === "dead" && (
											<Button size="sm" className="shrink-0" disabled={busy} onClick={() => replay(d.id)}>Replay</Button>
										)}
										{d.traceId && (
											<Button size="sm" className="shrink-0" onClick={() => toggleTrace(d)}>
												{openTrace === d.id ? "Hide run" : "Run"}
											</Button>
										)}
									</div>
								</div>
								{openTrace === d.id && (
									<div className="mt-2 border-t border-line pt-2">
										<div className="text-2xs text-muted-soft break-all mb-1">trace {d.traceId}</div>
										{trace === null && <div className="text-2xs text-muted">Loading…</div>}
										{trace?.length === 0 && <div className="text-2xs text-muted">No events recorded for this run.</div>}
										{trace?.map((e, i) => (
											<div key={e.id || `${e.ts}-${i}`} className={`text-2xs ${e.level === "error" ? "text-danger" : "text-muted"} break-words`}>
												<code>{e.event}</code> {plainMarkdown(e.message ?? "")}
											</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
			{msg && <div className="text-xs text-danger mt-3">{msg}</div>}
		</Card>
	);
}
