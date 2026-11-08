import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../components/Button";
import Card from "../components/Card";
import HistoryLine from "../components/HistoryLine";
import { deliveriesLine, type HistoryLineState } from "../lib/historyLine";
import {
	buildConnectionConfig,
	canDelegate,
	connectionHealth,
	deliveryCounts,
	describeFilter,
	directionState,
	pauseControl,
	supervisionState,
	toneClass,
	MAX_DIRECTION_CHARS,
	type Direction,
	FILTER_OPS,
	VALUELESS_OPS,
	type ClauseDraft,
	type Connection,
	type Delivery,
	type ToolVerdict,
} from "../lib/teamwork";

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
 *
 * Deliveries, the outbox, are history, not settings: the log (retry, dead-lettering, Replay, trace
 * correlation) lives in Activity → History (`tabs/activity/DeliveriesPanel.tsx`, #1590). This card keeps
 * one line saying how many never arrived, and the per-connection health the same rows feed.
 * The rules that turn a row into a sentence are pure and tested in ../lib/teamwork.ts.
 */

type Instance = { id: string; name?: string; slug?: string; agentName?: string };
type SupervisionLink = {
	id: string;
	supervisorInstanceId: string;
	subordinateInstanceId: string;
	enabled: boolean;
	/** The standing direction for THIS edge (#330) — what that agent is for, durable. */
	direction?: Direction | null;
};

const ACTIONS = ["run_pipeline", "insert_record", "create_task", "add_knowledge"] as const;

const EMPTY_CLAUSE: ClauseDraft = { field: "", op: "eq", value: "" };

export default function TeamworkSection({ instanceId }: { instanceId: string }) {
	const [instances, setInstances] = useState<Instance[]>([]);
	const [links, setLinks] = useState<SupervisionLink[]>([]);
	const [connections, setConnections] = useState<Connection[]>([]);
	const [deliveries, setDeliveries] = useState<Delivery[]>([]);
	// Its own load: the log moved to Activity, and a failed read here must say so rather than read as "nothing undelivered".
	const [deliveriesStatus, setDeliveriesStatus] = useState<"loading" | "ready" | "failed">("loading");
	// #354: whether this agent can delegate at all. Supervision is offered only if it can;
	// Connections and Deliveries stay ungated, because any agent can emit a fact and any agent
	// can be a target. Starts true so an existing link never blinks out while the answer loads.
	const [delegates, setDelegates] = useState(true);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	const [subordinate, setSubordinate] = useState("");
	// Per-edge direction edits, keyed by link id. Absent = show what is stored; a draft only
	// exists while the owner is typing, so a reload never fights the cursor.
	const [directionDraft, setDirectionDraft] = useState<Record<string, string>>({});
	const [eventType, setEventType] = useState("");
	const [target, setTarget] = useState("");
	const [action, setAction] = useState<(typeof ACTIONS)[number]>("run_pipeline");
	const [pipeline, setPipeline] = useState("");
	// Routing filter (#182). Several clauses, because the canonical case — "only Sydney leads
	// rated 4+" — is TWO of them, and a one-clause editor could not express the example the
	// feature was built for.
	const [clauses, setClauses] = useState<ClauseDraft[]>([{ ...EMPTY_CLAUSE }]);
	const [anyClause, setAnyClause] = useState(false);

	const nameOf = useCallback(
		(id: string) => {
			const i = instances.find((x) => x.id === id);
			return i?.name || i?.agentName || i?.slug || id;
		},
		[instances],
	);

	const load = useCallback(async () => {
		try {
			const [mine, sup, conns, tools] = await Promise.all([
				// `{instances}`, not a bare array — every other caller in the console reads it that
				// way. Reading it as an array made `Array.isArray` permanently false, so the list
				// was always empty and BOTH pickers below could never be set: supervision and
				// connections were unwireable from the UI, silently.
				api<{ instances: Instance[] }>("/v1/instances/my/instances").catch(() => ({ instances: [] })),
				api<{ supervision: SupervisionLink[] }>(`/v1/instances/${instanceId}/supervision`).catch(() => ({ supervision: [] })),
				api<{ connections: Connection[] }>(`/v1/instances/${instanceId}/connections`).catch(() => ({ connections: [] })),
				// The tool listing, for the one fact the supervision editor needs: does this agent
				// declare a supervision tool. It carries each tool's registry `connector`, so this
				// asks the same source the route rejects against instead of a second copy of it.
				api<{ tools: ToolVerdict[] }>(`/v1/instances/${instanceId}/tools`).catch(() => ({ tools: [] })),
			]);
			setInstances(mine.instances ?? []);
			setLinks(sup.supervision ?? []);
			setConnections(conns.connections ?? []);
			// An unreadable listing must not hide an editor the route would accept — only a
			// listing that came back and said no does that.
			setDelegates(tools.tools?.length ? canDelegate(tools.tools) : true);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	const loadDeliveries = useCallback(async () => {
		try {
			// EVERY status, not just dead: the health of a connection is a statement about
			// what it HAS carried, so filtering server-side would make "nothing has ever
			// matched" indistinguishable from "nothing has died".
			const d = await api<{ deliveries: Delivery[] }>(`/v1/instances/${instanceId}/connections/deliveries?limit=200`);
			setDeliveries(d.deliveries ?? []);
			setDeliveriesStatus("ready");
		} catch {
			setDeliveriesStatus("failed");
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
		void loadDeliveries();
	}, [load, loadDeliveries]);

	const others = instances.filter((i) => i.id !== instanceId);
	const counts = useMemo(() => deliveryCounts(deliveries), [deliveries]);
	const undelivered: HistoryLineState = deliveriesStatus === "ready" ? deliveriesLine(counts.dead) : { status: deliveriesStatus };

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

	/**
	 * Set or clear one subordinate's DIRECTION (#330).
	 *
	 * This surface is the only place `setBy: "user"` can be produced — the route it calls is what
	 * stamps it, and the agent's own tool cannot reach it. So "Save" on a proposal the agent wrote
	 * is the confirmation step: the same text, re-sent by the person whose direction it is.
	 */
	const saveDirection = async (id: string, text: string | null) => {
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/supervision/${id}/direction`, {
				method: text === null ? "DELETE" : "PUT",
				...(text === null ? {} : { body: JSON.stringify({ direction: text }) }),
			});
			setDirectionDraft((d) => {
				const next = { ...d };
				delete next[id];
				return next;
			});
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	/**
	 * Pause or resume ONE edge — a supervision link (#664) or a connection (#644). Both columns
	 * got their writer and their `PATCH …/{id} {enabled}` route in those tickets and neither got a
	 * control (#667), so for a console user "stand this agent down" or "pause this chain" was
	 * still only "delete the edge" — which throws away the subordinate's standing DIRECTION and
	 * the edge's budget defaults, or a connection's routing filter and target pipeline, and
	 * orphans the outbox rows that say what is stuck.
	 *
	 * The row is patched IN PLACE from the response rather than reloaded: the route returns the
	 * full updated view, so a refetch would re-read four endpoints to learn one bit — and would
	 * silently discard a direction the owner is mid-edit on, since `load()` is what clears
	 * `directionDraft`'s sibling state around it.
	 *
	 * `pauseControl` produces the boolean. The route rejects `"false"` and `0` rather than
	 * coercing them, because coercion on the one field whose job is to STOP work would do the
	 * opposite of what was asked; keeping the value in a tested pure function is how that stays
	 * true here as well as there.
	 */
	const toggleSupervision = async (link: SupervisionLink) => {
		setBusy(true);
		setMsg("");
		try {
			const updated = await api<SupervisionLink>(`/v1/instances/${instanceId}/supervision/${link.id}`, {
				method: "PATCH",
				body: JSON.stringify({ enabled: pauseControl(link.enabled).next }),
			});
			setLinks((ls) => ls.map((l) => (l.id === link.id ? { ...l, ...updated } : l)));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	const removeSupervision = async (id: string) => {
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/supervision/${id}`, { method: "DELETE" });
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
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
					config: buildConnectionConfig({ action, pipeline, clauses, any: anyClause }),
				}),
			});
			setEventType("");
			setPipeline("");
			setClauses([{ ...EMPTY_CLAUSE }]);
			setAnyClause(false);
			// The reload is what shows the create-time warnings (#363): the listing annotates every
			// row with the same sentences the create path returns, so the new edge appears already
			// carrying its warning — while the human is still here — and keeps carrying it.
			await load();
		} catch (e) {
			// A filter the server can prove would never match is a 400 here rather than a chain
			// that stops months later with every row still reading "enabled".
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	/** The connection half of {@link toggleSupervision}; same column, same route shape, same rule. */
	const toggleConnection = async (cn: Connection) => {
		setBusy(true);
		setMsg("");
		try {
			const updated = await api<Connection>(`/v1/instances/${instanceId}/connections/${cn.id}`, {
				method: "PATCH",
				body: JSON.stringify({ enabled: pauseControl(cn.enabled).next }),
			});
			setConnections((cs) => cs.map((c) => (c.id === cn.id ? { ...c, ...updated } : c)));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	const removeConnection = async (id: string) => {
		setBusy(true);
		try {
			await api(`/v1/instances/${instanceId}/connections/${id}`, { method: "DELETE" });
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	const setClause = (i: number, patch: Partial<ClauseDraft>) =>
		setClauses((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));

	const field = "text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full min-w-0";

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Teamwork</h3>
			<p className="text-sm text-muted mb-4">
				How this agent works with your others.{" "}
				{delegates && <><strong>Supervision</strong> hands another agent a goal and tracks the result.{" "}</>}
				<strong>Connections</strong> announce a fact and let any agent react.
			</p>

			{/* ── Supervision ───────────────────────────────────────────
			    Offered only to an agent that CAN delegate (#354). The graph is instance-level and
			    the ability is agent-level, and this editor used to ignore the second half: it
			    offered the wiring on all 26 instances, 25 of which have no delegation tool, and
			    the route agreed with the picker rather than with the runtime. Existing links are
			    still listed when the ability is absent — a row already written has to be
			    removable — but nothing new can be added. */}
			{(delegates || links.length > 0) && (
			<div className="mb-5">
				<div className="text-sm font-semibold mb-2">Agents this one supervises</div>
				{links.length === 0 && <div className="text-xs text-muted mb-2">None yet — it has nobody to delegate to.</div>}
				{/* Each row carries that agent's DIRECTION (#330) — the durable "what is this one
				    for", which the Lead previously had to reconstruct from recent runs. The
				    proposed-vs-set distinction is rendered, not just stored: an agent may propose a
				    direction, and only the owner saving it here makes it authoritative. */}
				{links.map((l) => {
					const state = directionState(l.direction);
					const paused = supervisionState(l.enabled);
					const control = pauseControl(l.enabled);
					const draft = directionDraft[l.id];
					const value = draft ?? l.direction?.text ?? "";
					const dirty = draft !== undefined && draft.trim() !== (l.direction?.text ?? "");
					// A proposal is savable UNCHANGED — that is exactly what confirming it is.
					const canSave = value.trim().length > 0 && value.length <= MAX_DIRECTION_CHARS && (dirty || l.direction?.setBy === "agent");
					return (
					<div key={l.id} className="text-sm border border-line rounded-lg px-3 py-2 mb-1">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate">{nameOf(l.subordinateInstanceId)}</span>
							<div className="flex gap-2 shrink-0">
								{/* Standing a subordinate down while it is reconfigured is an ordinary act;
								    before this the only way to do it was Remove, which costs the epic. */}
								<Button size="sm" className="shrink-0" disabled={busy} onClick={() => toggleSupervision(l)}>{control.action}</Button>
								<Button size="sm" className="shrink-0" disabled={busy} onClick={() => removeSupervision(l.id)}>Remove</Button>
							</div>
						</div>
						{/* Paused is NOT broken: the muted tone is the one a paused connection already
						    uses, deliberately not the warning tone the failures are painted in. */}
						{paused.label && <div className={`text-xs mt-1 ${toneClass(paused.tone)}`}>{paused.label}</div>}
						<div className={`text-xs mt-1 ${toneClass(state.tone)}`}>{state.label}</div>
						<div className="flex flex-col sm:flex-row gap-2 mt-1">
							<input
								aria-label={`Direction for ${nameOf(l.subordinateInstanceId)}`}
								placeholder="What is this agent for? e.g. finish the voice port and keep the suite green"
								maxLength={MAX_DIRECTION_CHARS}
								value={value}
								onChange={(e) => setDirectionDraft((d) => ({ ...d, [l.id]: e.target.value }))}
								className={field}
							/>
							<div className="flex gap-2 shrink-0">
								<Button size="sm" className="shrink-0" disabled={busy || !canSave} onClick={() => saveDirection(l.id, value.trim())}>
									{l.direction?.setBy === "agent" && !dirty ? "Confirm" : "Save"}
								</Button>
								{/* Clearing IS closing the epic — there is no lifecycle and nothing
								    auto-closes it, because a subordinate finishing a task cannot know. */}
								{l.direction && <Button size="sm" className="shrink-0" disabled={busy} onClick={() => saveDirection(l.id, null)}>Clear</Button>}
							</div>
						</div>
					</div>
					);
				})}
				{delegates ? (
				<div className="flex flex-col sm:flex-row gap-2 mt-2">
					<select aria-label="Agent to supervise" value={subordinate} onChange={(e) => setSubordinate(e.target.value)} className={field}>
						<option value="">Add an agent to supervise…</option>
						{others.map((i) => <option key={i.id} value={i.id}>{i.name || i.agentName || i.slug || i.id}</option>)}
					</select>
					<Button variant="primary" size="lg" className="whitespace-nowrap" disabled={busy || !subordinate} onClick={addSupervision}>Add agent</Button>
				</div>
				) : (
					<div className="text-xs text-warning mt-2">This agent can’t delegate — its tools include none of the supervision tools, so these links do nothing. Remove them, or supervise from an agent that can.</div>
				)}
			</div>
			)}

			{/* ── Connections ─────────────────────────────────────────── */}
			<div className="mb-5">
				<div className="text-sm font-semibold mb-2">Events this one sends</div>
				{connections.length === 0 && <div className="text-xs text-muted mb-2">None yet.</div>}
				{connections.map((cn) => {
					// Only once the deliveries it is judged by have loaded: before that "nothing has matched" would be a claim, not a report.
					const health = deliveriesStatus === "ready" ? connectionHealth(cn, deliveries) : null;
					const filter = describeFilter(cn.config);
					return (
						<div key={cn.id} className="flex items-start justify-between gap-2 text-sm border border-line rounded-lg px-3 py-2 mb-1">
							<div className="min-w-0">
								<div className="truncate">
									<code className="text-xs">{cn.eventType}</code> → {nameOf(cn.targetInstanceId)}{" "}
									<span className="text-muted text-xs">({cn.action})</span>
								</div>
								{/* A predicate that is not on screen is indistinguishable from a broken chain. */}
								{filter && <div className="text-2xs text-muted-soft break-words">only when {filter}</div>}
								{health && <div className={`text-2xs ${toneClass(health.tone)}`}>{health.text}</div>}
								{/* #363: rows written before the create-time check existed may already name a
								    pipeline the target does not have. Surfaced, not removed — "Remove" is right
								    there, and a connection the user wrote is theirs to delete. */}
								{(cn.warnings ?? []).map((w) => (
									<div key={w} className="text-2xs text-warning break-words">{w}</div>
								))}
							</div>
							{/* Stacked, matching the delivery rows below, which already stack Replay above
							    Run. Measured rather than assumed: side by side ALSO fits at 320 and 390
							    in both engines, so this is consistency and not an overflow fix — the
							    geometry guard in e2e/console.spec.ts stays green either way, and was
							    proven able to go red on this row before it was believed. */}
							<div className="flex flex-col gap-1 shrink-0">
								<Button size="sm" className="shrink-0" disabled={busy} onClick={() => toggleConnection(cn)}>{pauseControl(cn.enabled).action}</Button>
								<Button size="sm" className="shrink-0" disabled={busy} onClick={() => removeConnection(cn.id)}>Remove</Button>
							</div>
						</div>
					);
				})}
				<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 mt-2">
					<input value={eventType} onChange={(e) => setEventType(e.target.value)} aria-label="Event that triggers this connection" placeholder="Event, e.g. lead.created" className={field} />
					<select aria-label="Connection target agent" value={target} onChange={(e) => setTarget(e.target.value)} className={field}>
						<option value="">Send to…</option>
						{others.map((i) => <option key={i.id} value={i.id}>{i.name || i.agentName || i.slug || i.id}</option>)}
					</select>
					<select aria-label="Connection action" value={action} onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])} className={field}>
						{ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
					</select>
					<Button variant="primary" size="lg" className="whitespace-nowrap" disabled={busy || !eventType.trim() || !target} onClick={addConnection}>Add event</Button>
				</div>
				{action === "run_pipeline" && (
					<input value={pipeline} onChange={(e) => setPipeline(e.target.value)} aria-label="Pipeline to run on the target agent" placeholder="Pipeline name to run on the target" className={`${field} mt-2`} />
				)}

				{/* Routing filter — validated server-side at create time, so a predicate that could
				    never match is rejected here rather than quietly stopping the chain later. */}
				<div className="mt-3 border-t border-line pt-3">
					<div className="flex items-center flex-wrap gap-2 mb-2">
						<span className="text-xs font-semibold">Only send when…</span>
						<label className="text-2xs text-muted flex items-center gap-1">
							<input type="checkbox" aria-label="Match any condition" checked={anyClause} onChange={(e) => setAnyClause(e.target.checked)} />
							match any (instead of all)
						</label>
					</div>
					{clauses.map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and have no id
						<div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-2 mb-2">
							<input
								aria-label={`Filter field ${i + 1}`}
								value={c.field}
								onChange={(e) => setClause(i, { field: e.target.value })}
								placeholder="field, e.g. suburb (optional)"
								className={field}
							/>
							<select aria-label={`Filter operator ${i + 1}`} value={c.op} onChange={(e) => setClause(i, { op: e.target.value })} className={field}>
								{FILTER_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
							</select>
							{VALUELESS_OPS.has(c.op) ? <span /> : (
								<input
									aria-label={`Filter value ${i + 1}`}
									value={c.value}
									onChange={(e) => setClause(i, { value: e.target.value })}
									placeholder={c.op === "in" ? "comma,separated,values" : "value"}
									className={field}
								/>
							)}
							<Button
								size="sm"
								className="shrink-0"
								aria-label={`Remove condition ${i + 1}`}
								disabled={clauses.length === 1}
								onClick={() => setClauses((cs) => cs.filter((_, n) => n !== i))}
							>
								−
							</Button>
						</div>
					))}
					<Button size="sm" className="shrink-0" onClick={() => setClauses((cs) => [...cs, { ...EMPTY_CLAUSE }])}>
						+ Add condition
					</Button>
					{/* The strict-equality trap, stated once rather than discovered by a chain that
					    silently carries nothing: "4" is not 4, and quoting forces text. */}
					<p className="text-2xs text-muted-soft mt-2">
						Numbers and true/false/null are read as typed. Wrap a value in quotes to keep it text — e.g. <code>"2000"</code> for a postcode.
					</p>
				</div>
			</div>

			{/* ── Deliveries (the outbox): the log is in Activity → History ─ */}
			<HistoryLine instanceId={instanceId} panel="deliveries" state={undelivered} testId="deliveries-line" />

			{msg && <div className="text-xs text-danger mt-3">{msg}</div>}
		</Card>
	);
}
