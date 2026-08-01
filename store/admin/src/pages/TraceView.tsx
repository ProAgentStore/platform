import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface TraceEvent {
	id: string;
	ts: number;
	created_at: string;
	user_id: string | null;
	instance_id: string | null;
	trace_id: string | null;
	source: string;
	level: string;
	event: string;
	message: string | null;
	context: string | null;
}

const LIMITS = ["100", "200", "500", "1000"];
const levelColor = (l: string) =>
	l === "error" ? "text-red" : l === "warn" ? "text-yellow" : "text-muted";

export default function TraceView() {
	const { instanceId } = useParams<{ instanceId: string }>();
	const [source, setSource] = useState("");
	const [level, setLevel] = useState("");
	const [traceId, setTraceId] = useState("");
	const [traceIdDebounced, setTraceIdDebounced] = useState("");
	const [limit, setLimit] = useState("200");
	const [events, setEvents] = useState<TraceEvent[] | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => { const t = setTimeout(() => setTraceIdDebounced(traceId.trim()), 300); return () => clearTimeout(t); }, [traceId]);

	const qs = useMemo(() => {
		const p = new URLSearchParams();
		if (source) p.set("source", source);
		if (level) p.set("level", level);
		if (traceIdDebounced) p.set("trace_id", traceIdDebounced);
		if (limit) p.set("limit", limit);
		return p.toString();
	}, [source, level, traceIdDebounced, limit]);

	useEffect(() => {
		if (!instanceId) return;
		setErr("");
		setEvents(null);
		api<{ events: TraceEvent[] }>(`/v1/admin/trace/${encodeURIComponent(instanceId)}${qs ? `?${qs}` : ""}`)
			.then((r) => setEvents(r.events))
			.catch((e) => setErr(e.message));
	}, [instanceId, qs]);

	// Source options: derive from whatever we've loaded (best-effort).
	const sources = useMemo(() => {
		const s = new Set<string>();
		(events || []).forEach((x) => s.add(x.source));
		return [...s].sort();
	}, [events]);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Run Trace</h1>
			<p className="text-sm text-muted mb-4">
				Time-ordered event stream for instance <span className="font-mono text-ink">{instanceId}</span> — chat turns, tool calls, apply steps, and errors interleaved.
			</p>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<select value={source} onChange={(e) => setSource(e.target.value)} className="!w-auto text-sm">
					<option value="">All sources</option>
					{sources.map((s) => <option key={s} value={s}>{s}</option>)}
				</select>
				<select value={level} onChange={(e) => setLevel(e.target.value)} className="!w-auto text-sm">
					<option value="">All levels</option>
					<option value="debug">debug</option>
					<option value="info">info</option>
					<option value="warn">warn</option>
					<option value="error">error</option>
				</select>
				<select value={limit} onChange={(e) => setLimit(e.target.value)} className="!w-auto text-sm">
					{LIMITS.map((l) => <option key={l} value={l}>{l} rows</option>)}
				</select>
				<input placeholder="Filter by trace_id…" value={traceId} onChange={(e) => setTraceId(e.target.value)} className="!w-auto flex-1 min-w-[180px] text-sm font-mono" />
			</div>

			{err ? <ErrorBox message={err} /> : !events ? <Loading /> : !events.length ? (
				<Empty label="No events for this instance in the current filter." />
			) : (
				<Panel>
					<div className="space-y-1.5">
						{events.map((e) => <TraceRow key={e.id} e={e} />)}
					</div>
				</Panel>
			)}
		</div>
	);
}

function TraceRow({ e }: { e: TraceEvent }) {
	const [open, setOpen] = useState(false);
	const hasContext = !!e.context && e.context !== "null";
	return (
		<div className="border-b border-line/50 pb-1.5">
			<div className="flex flex-wrap gap-2 text-xs text-muted cursor-pointer" onClick={() => setOpen(!open)}>
				<span className="whitespace-nowrap">{e.created_at?.slice(5, 19)}</span>
				<span className="text-accent">{e.source}</span>
				<span className={levelColor(e.level)}>{e.level}</span>
				<span className="text-ink">{e.event}</span>
				{e.trace_id && <span className="truncate max-w-[160px] font-mono text-muted-soft">{e.trace_id}</span>}
				{e.user_id && <span className="truncate max-w-[140px]">{e.user_id}</span>}
			</div>
			{e.message && <div className="break-words text-sm cursor-pointer" onClick={() => setOpen(!open)}>{e.message}</div>}
			{open && hasContext && <ContextBlock context={e.context as string} />}
		</div>
	);
}

function ContextBlock({ context }: { context: string }) {
	let pretty = context;
	try { pretty = JSON.stringify(JSON.parse(context), null, 2); } catch { /* raw */ }
	return <pre className="text-xs bg-paper border border-line rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto font-mono text-muted">{pretty}</pre>;
}
