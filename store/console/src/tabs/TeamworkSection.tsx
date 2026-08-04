import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";

/**
 * How this agent works with your other agents (#182).
 *
 * Two DIFFERENT edges, deliberately shown apart rather than merged into one "links" list:
 *
 *  • Supervision — this agent hands another a GOAL and owns the result. A named tree.
 *  • Connections — this agent announces a FACT and does not know who consumes it. A fan-out.
 *
 * Collapsing them would lose the distinction that matters when something goes wrong: a
 * supervised run reports back and escalates to its supervisor, a routed event does not.
 *
 * Until this existed, both were reachable only by curl or MCP — so assembling a multi-agent
 * system, the whole point of the supervision work, was not something you could do with a mouse.
 */

type Instance = { id: string; name?: string; slug?: string; agentName?: string };
type SupervisionLink = { id: string; supervisorInstanceId: string; subordinateInstanceId: string; enabled: boolean };
type Connection = { id: string; eventType: string; targetInstanceId: string; action: string };
type Delivery = {
	id: string;
	status: string;
	attempts: number;
	nextAttemptAt?: string | null;
	lastError?: string | null;
	eventType?: string;
};

const ACTIONS = ["run_pipeline", "insert_record", "create_task", "add_knowledge"] as const;

export default function TeamworkSection({ instanceId }: { instanceId: string }) {
	const [instances, setInstances] = useState<Instance[]>([]);
	const [links, setLinks] = useState<SupervisionLink[]>([]);
	const [connections, setConnections] = useState<Connection[]>([]);
	const [deliveries, setDeliveries] = useState<Delivery[]>([]);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	const [subordinate, setSubordinate] = useState("");
	const [eventType, setEventType] = useState("");
	const [target, setTarget] = useState("");
	const [action, setAction] = useState<(typeof ACTIONS)[number]>("run_pipeline");
	const [pipeline, setPipeline] = useState("");
	const [showDead, setShowDead] = useState(false);

	const nameOf = useCallback(
		(id: string) => instances.find((i) => i.id === id)?.name || instances.find((i) => i.id === id)?.agentName || id,
		[instances],
	);

	const load = useCallback(async () => {
		try {
			const [mine, sup, conns] = await Promise.all([
				api<Instance[]>("/v1/instances/my/instances").catch(() => []),
				api<{ supervision: SupervisionLink[] }>(`/v1/instances/${instanceId}/supervision`).catch(() => ({ supervision: [] })),
				api<{ connections: Connection[] }>(`/v1/instances/${instanceId}/connections`).catch(() => ({ connections: [] })),
			]);
			setInstances(Array.isArray(mine) ? mine : []);
			setLinks(sup.supervision ?? []);
			setConnections(conns.connections ?? []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	const loadDeliveries = useCallback(async () => {
		try {
			// Dead letters first: "what is stuck" is the question you actually have. A delivery
			// that exhausted its retries is invisible everywhere else.
			const r = await api<{ deliveries: Delivery[] }>(`/v1/instances/${instanceId}/connections/deliveries?status=dead`);
			setDeliveries(r.deliveries ?? []);
		} catch {
			setDeliveries([]);
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);
	useEffect(() => { if (showDead) void loadDeliveries(); }, [showDead, loadDeliveries]);

	const others = instances.filter((i) => i.id !== instanceId);

	const addSupervision = async () => {
		if (!subordinate) return;
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/supervision`, {
				method: "POST",
				body: JSON.stringify({ subordinateInstanceId: subordinate }),
			});
			setSubordinate("");
			await load();
		} catch (e) {
			// The server rejects cycles, towers, fan-out and second supervisors at WIRING time.
			// Surfacing the reason here is the whole value of validating early.
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	const removeSupervision = async (id: string) => {
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/supervision/${id}`, { method: "DELETE" });
			await load();
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		setBusy(false);
	};

	const addConnection = async () => {
		if (!eventType.trim() || !target) return;
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/connections`, {
				method: "POST",
				body: JSON.stringify({
					eventType: eventType.trim(),
					targetInstanceId: target,
					action,
					config: action === "run_pipeline" && pipeline.trim() ? { pipeline: pipeline.trim() } : {},
				}),
			});
			setEventType("");
			setPipeline("");
			await load();
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		setBusy(false);
	};

	const removeConnection = async (id: string) => {
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/connections/${id}`, { method: "DELETE" });
			await load();
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		setBusy(false);
	};

	const replay = async (id: string) => {
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/connections/deliveries/${id}/replay`, { method: "POST" });
			await loadDeliveries();
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		setBusy(false);
	};

	const field = "text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full";
	const chip = "text-xs px-2 py-1 rounded-lg border border-line hover:bg-paper";

	return (
		<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Teamwork</h3>
			<p className="text-sm text-muted mb-4">
				How this agent works with your others. <strong>Supervision</strong> hands another agent a goal and
				tracks the result. <strong>Connections</strong> announce a fact and let any agent react.
			</p>

			{/* ── Supervision ─────────────────────────────────────────── */}
			<div className="mb-5">
				<div className="text-sm font-semibold mb-2">Agents this one supervises</div>
				{links.length === 0 && <div className="text-xs text-muted mb-2">None yet — it has nobody to delegate to.</div>}
				{links.map((l) => (
					<div key={l.id} className="flex items-center justify-between gap-2 text-sm border border-line rounded-lg px-3 py-2 mb-1">
						<span className="truncate">{nameOf(l.subordinateInstanceId)}</span>
						<button type="button" disabled={busy} onClick={() => removeSupervision(l.id)} className={chip}>Remove</button>
					</div>
				))}
				<div className="flex flex-col sm:flex-row gap-2 mt-2">
					<select aria-label="Agent to supervise" value={subordinate} onChange={(e) => setSubordinate(e.target.value)} className={field}>
						<option value="">Add an agent to supervise…</option>
						{others.map((i) => <option key={i.id} value={i.id}>{i.name || i.agentName || i.slug || i.id}</option>)}
					</select>
					<button type="button" disabled={busy || !subordinate} onClick={addSupervision} className="text-sm px-3 py-2 rounded-lg bg-accent text-white font-bold disabled:opacity-40 whitespace-nowrap">Add agent</button>
				</div>
			</div>

			{/* ── Connections ─────────────────────────────────────────── */}
			<div className="mb-5">
				<div className="text-sm font-semibold mb-2">Events this one sends</div>
				{connections.length === 0 && <div className="text-xs text-muted mb-2">None yet.</div>}
				{connections.map((cn) => (
					<div key={cn.id} className="flex items-center justify-between gap-2 text-sm border border-line rounded-lg px-3 py-2 mb-1">
						<span className="truncate">
							<code className="text-xs">{cn.eventType}</code> → {nameOf(cn.targetInstanceId)} <span className="text-muted text-xs">({cn.action})</span>
						</span>
						<button type="button" disabled={busy} onClick={() => removeConnection(cn.id)} className={chip}>Remove</button>
					</div>
				))}
				<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 mt-2">
					<input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="Event, e.g. lead.created" className={field} />
					<select aria-label="Connection target agent" value={target} onChange={(e) => setTarget(e.target.value)} className={field}>
						<option value="">Send to…</option>
						{others.map((i) => <option key={i.id} value={i.id}>{i.name || i.agentName || i.slug || i.id}</option>)}
					</select>
					<select aria-label="Connection action" value={action} onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])} className={field}>
						{ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
					</select>
					<button type="button" disabled={busy || !eventType.trim() || !target} onClick={addConnection} className="text-sm px-3 py-2 rounded-lg bg-accent text-white font-bold disabled:opacity-40 whitespace-nowrap">Add event</button>
				</div>
				{action === "run_pipeline" && (
					<input value={pipeline} onChange={(e) => setPipeline(e.target.value)} placeholder="Pipeline name to run on the target" className={`${field} mt-2`} />
				)}
			</div>

			{/* ── Dead letters ────────────────────────────────────────── */}
			<div>
				<button type="button" onClick={() => setShowDead((v) => !v)} className="text-sm font-semibold underline decoration-dotted">
					{showDead ? "Hide" : "Show"} undelivered events
				</button>
				{showDead && (
					<div className="mt-2">
						{deliveries.length === 0 && <div className="text-xs text-muted">Nothing stuck — every event reached its agent.</div>}
						{deliveries.map((d) => (
							<div key={d.id} className="flex items-start justify-between gap-2 text-sm border border-line rounded-lg px-3 py-2 mb-1">
								<span className="min-w-0">
									<code className="text-xs">{d.eventType || "event"}</code>
									<span className="text-muted text-xs"> · {d.attempts} attempts</span>
									{d.lastError && <div className="text-xs text-red truncate">{d.lastError}</div>}
								</span>
								{/* Retries wait out someone else's outage; when it is over, replay is the fix. */}
								<button type="button" disabled={busy} onClick={() => replay(d.id)} className={chip}>Replay</button>
							</div>
						))}
					</div>
				)}
			</div>

			{msg && <div className="text-xs text-red mt-3">{msg}</div>}
		</div>
	);
}
