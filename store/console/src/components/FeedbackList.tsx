import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { formatDateTime } from "@proagentstore/sdk/ui";
import { ChevronDown, ChevronRight, Flag, Trash2 } from "lucide-react";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import { FEEDBACK_STATUS_LABEL, previewOf, type FeedbackRow } from "../lib/feedback";

/**
 * What was recorded, and the two links that make it worth recording (#514).
 *
 * A feedback list that only shows opinions is a suggestion box. What made #503–#505 filable was
 * getting from the complaint to the CONVERSATION and to the TOOL CALLS of the turn — so every row
 * offers both, and says so plainly when it cannot: a message deleted since, or a trace older than
 * the 14 days `agent_events` keeps, leaves the snapshot readable and the link absent. That is a
 * degraded record rather than a broken one, and it is why the row carries both kinds of evidence.
 *
 * One component, two callers: the per-instance Feedback tab passes `instanceId`, the platform-wide
 * page does not — the same `errors.ts`-shaped route serves both.
 */

interface TraceEvent {
	id: string;
	ts: number;
	source: string;
	level: string;
	event: string;
	message: string | null;
}

const STATUSES = ["open", "triaged", "filed", "dismissed"] as const;

export default function FeedbackList({ instanceId, agentNames }: { instanceId?: string; agentNames?: Record<string, string> }) {
	const [rows, setRows] = useState<FeedbackRow[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<string>("");
	const [open, setOpen] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const q = new URLSearchParams();
			if (instanceId) q.set("instance_id", instanceId);
			if (filter) q.set("status", filter);
			const data = await api<{ feedback?: FeedbackRow[] }>(`/v1/feedback?${q}`);
			setRows(data.feedback || []);
			setError(null);
		} catch (e) {
			// Reported, not swallowed (#291): an empty list and a failed read look identical, and
			// "I flagged that and it is not here" is the worst possible thing for this surface to say.
			setError(e instanceof Error ? e.message : "Couldn't load feedback");
		}
	}, [instanceId, filter]);

	useEffect(() => {
		void load();
	}, [load]);

	const patch = async (id: string, body: Record<string, unknown>) => {
		await api(`/v1/feedback/${id}`, { method: "PATCH", body: JSON.stringify(body) });
		await load();
	};

	const remove = async (id: string) => {
		if (!confirm("Delete this feedback? It is the record of what you said at the time, and there is no undo.")) return;
		await api(`/v1/feedback/${id}`, { method: "DELETE" });
		await load();
	};

	if (error) return <LoadFailed what="your feedback" detail={error} onRetry={() => void load()} />;

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
				<div>
					<h3 className="text-base font-bold mb-0.5 flex items-center gap-1.5">
						<Flag size={15} /> Feedback
					</h3>
					<div className="text-xs text-muted">
						{rows.length} item{rows.length === 1 ? "" : "s"} · what you said went wrong, kept with the turn it is about
					</div>
				</div>
				<label className="text-xs text-muted flex items-center gap-1.5">
					Status
					<select
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						aria-label="Filter feedback by status"
						className="bg-panel border border-line rounded-lg px-2 py-1 text-xs"
					>
						<option value="">All</option>
						{STATUSES.map((s) => (
							<option key={s} value={s}>
								{FEEDBACK_STATUS_LABEL[s]}
							</option>
						))}
					</select>
				</label>
			</div>

			{rows.length === 0 ? (
				<Card className="text-xs text-muted">
					Nothing yet. Use the flag on a message — or the ⋮ menu on a phone — to record what went wrong. The record keeps
					the message, the turn before it, and a link back to what the agent actually ran.
				</Card>
			) : (
				<div className="flex flex-col gap-2">
					{rows.map((r) => (
						<FeedbackCard
							key={r.id}
							row={r}
							agentName={agentNames?.[r.instance_id]}
							showAgent={!instanceId}
							expanded={open === r.id}
							onToggle={() => setOpen(open === r.id ? null : r.id)}
							onPatch={(body) => void patch(r.id, body)}
							onDelete={() => void remove(r.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function FeedbackCard({
	row,
	agentName,
	showAgent,
	expanded,
	onToggle,
	onPatch,
	onDelete,
}: {
	row: FeedbackRow;
	agentName?: string;
	showAgent: boolean;
	expanded: boolean;
	onToggle: () => void;
	onPatch: (body: Record<string, unknown>) => void;
	onDelete: () => void;
}) {
	const [trace, setTrace] = useState<TraceEvent[] | null>(null);
	const [traceErr, setTraceErr] = useState<string | null>(null);
	const ctx = parseContext(row.context);

	const loadTrace = async () => {
		if (!row.trace_id) return;
		try {
			const d = await api<{ events?: TraceEvent[] }>(
				`/v1/instances/${row.instance_id}/trace?trace_id=${encodeURIComponent(row.trace_id)}&limit=50`,
			);
			setTrace(d.events || []);
			setTraceErr(null);
		} catch (e) {
			setTraceErr(e instanceof Error ? e.message : "Couldn't load the trace");
		}
	};

	return (
		<Card>
			<div className="flex items-start justify-between gap-2">
				<button type="button" onClick={onToggle} aria-label={expanded ? "Collapse this feedback" : "Expand this feedback"} className="flex-1 min-w-0 text-left flex items-start gap-1.5">
					{expanded ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted" />}
					<div className="min-w-0">
						<div className="text-sm leading-relaxed">{row.body}</div>
						<div className="text-2xs text-muted mt-0.5 flex items-center gap-2 flex-wrap">
							<span>{formatDateTime(new Date(row.ts).toISOString())}</span>
							{showAgent && <span>· {agentName || row.instance_id.slice(0, 8)}</span>}
							{row.author === "agent" && <span>· recorded by the agent</span>}
							{row.sentiment === "good" && <span>· positive</span>}
						</div>
					</div>
				</button>
				<span className="text-2xs px-2 py-0.5 rounded-full border border-line text-muted shrink-0">{FEEDBACK_STATUS_LABEL[row.status] ?? row.status}</span>
			</div>

			{expanded && (
				<div className="mt-3 flex flex-col gap-3">
					{row.prompt_text && (
						<Quote label="The turn before it" text={row.prompt_text} />
					)}
					{row.target_text && (
						<Quote label={row.target_role === "user" ? "Your message" : "The agent said"} text={row.target_text} />
					)}
					{(ctx.dictation || ctx.audioKey) ? (
						<div className="text-2xs text-muted">
							Voice turn{ctx.voiceFrom === "prompt" ? " (the one before this)" : ""}
							{ctx.dictation ? <> · the recognizer heard <i>“{String(ctx.dictation)}”</i></> : null}
						</div>
					) : null}

					<div className="flex items-center gap-2 flex-wrap">
						<Link to={`/instances/${row.instance_id}`} className="text-xs text-accent font-semibold underline underline-offset-2">
							Open the conversation
						</Link>
						{row.trace_id ? (
							<Button size="sm" onClick={() => void loadTrace()}>
								Show what it ran
							</Button>
						) : (
							// Said plainly rather than hidden: a message from before turn ids existed, or one
							// sent over the WebSocket path, has no trace to open and the snapshot above is
							// the whole record.
							<span className="text-2xs text-muted">No trace was recorded for this turn.</span>
						)}
						{row.issue_url && (
							<a href={row.issue_url} target="_blank" rel="noreferrer" className="text-xs text-accent font-semibold underline underline-offset-2">
								Issue
							</a>
						)}
					</div>

					{traceErr && <div className="text-2xs text-danger">{traceErr}</div>}
					{trace && (
						<div className="border border-line rounded-lg divide-y divide-line">
							{trace.length === 0 ? (
								<div className="text-2xs text-muted p-2">
									The trace for this turn is gone — it is kept for 14 days. The quoted messages above are not.
								</div>
							) : (
								trace.map((e) => (
									<div key={e.id} className="text-2xs p-2 flex gap-2">
										<span className={`font-mono shrink-0 ${e.level === "warn" || e.level === "error" ? "text-danger" : "text-muted"}`}>{e.event}</span>
										<span className="min-w-0 break-words">{previewOf(e.message, 300)}</span>
									</div>
								))
							)}
						</div>
					)}

					<div className="flex items-center gap-2 flex-wrap">
						<label className="text-2xs text-muted flex items-center gap-1.5">
							Status
							<select
								value={row.status}
								onChange={(e) => onPatch({ status: e.target.value })}
								aria-label="Feedback status"
								className="bg-paper border border-line rounded-lg px-2 py-1 text-xs"
							>
								{STATUSES.map((s) => (
									<option key={s} value={s}>
										{FEEDBACK_STATUS_LABEL[s]}
									</option>
								))}
							</select>
						</label>
						<input
							defaultValue={row.issue_url ?? ""}
							onBlur={(e) => {
								if (e.target.value !== (row.issue_url ?? "")) onPatch({ issue_url: e.target.value });
							}}
							aria-label="Issue this became"
							placeholder="https://github.com/…/issues/123"
							className="flex-1 min-w-[12rem] bg-paper border border-line rounded-lg px-2 py-1 text-xs"
						/>
						<Button variant="danger" size="sm" onClick={onDelete} aria-label="Delete this feedback">
							<Trash2 size={13} />
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}

function Quote({ label, text }: { label: string; text: string }) {
	return (
		<div className="text-2xs text-muted bg-paper border border-line rounded-lg px-2.5 py-2">
			<span className="font-bold uppercase tracking-wide">{label}</span>
			<div className="mt-0.5 leading-relaxed whitespace-pre-wrap break-words">{previewOf(text, 1200)}</div>
		</div>
	);
}

function parseContext(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
