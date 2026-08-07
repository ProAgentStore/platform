import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";

// Spreadsheet + board view over an agent's structured collections:
// filter/sort, show/hide columns, edit the status pipeline inline, toggle a
// kanban board grouped by status, and export the current view to CSV.

interface Field {
	name: string;
	type?: string;
}
interface Collection {
	name: string;
	fields?: Field[];
	recordCount?: number;
}
interface Rec {
	id: string;
	data: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}
// A pipeline run record (issue #98) — GET /v1/instances/:id/pipeline-runs.
interface Run {
	run_id: string;
	pipeline: string;
	trigger: string;
	status: string;
	started_at: number;
	finished_at: number | null;
	seen: number;
	added: number;
	skipped: number;
	errors: number;
	detail: string | null;
}

const PIPELINE = ["new", "contacted", "won", "dead"];
const FILTERABLE = new Set(["status", "country", "state", "city", "suburb", "website_status"]);
const DATETIME = new Set(["found_at", "checked_at", "created_at", "createdAt", "updatedAt"]);

const STATUS_CLASS: Record<string, string> = {
	new: "bg-blue-100 text-blue-700",
	contacted: "bg-amber-100 text-amber-700",
	won: "bg-green-100 text-green-700",
	dead: "bg-gray-200 text-gray-600",
	none: "bg-green-100 text-green-700",
	unreachable: "bg-amber-100 text-amber-700",
	// Pipeline run statuses (issue #98).
	running: "bg-blue-100 text-blue-700",
	completed: "bg-green-100 text-green-700",
	failed: "bg-red-100 text-red-700",
	interrupted: "bg-amber-100 text-amber-700",
};

function Badge({ value }: { value: string }) {
	const cls = STATUS_CLASS[value] || "bg-gray-100 text-gray-600";
	return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{value}</span>;
}

function fmtDateTime(v: unknown): string {
	if (v == null || v === "") return "";
	// Accept ms-epoch numbers (pipeline run timestamps) as well as date strings.
	const d = typeof v === "number" ? new Date(v) : new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

export default function DataTab({ instanceId }: { instanceId: string }) {
	const [collections, setCollections] = useState<Collection[]>([]);
	const [selected, setSelected] = useState("");
	const [records, setRecords] = useState<Rec[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [q, setQ] = useState("");
	const [sortBy, setSortBy] = useState("");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
	const [view, setView] = useState<"table" | "board">("table");
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [showCols, setShowCols] = useState(false);
	const [filters, setFilters] = useState<Record<string, string>>({});
	const [showControls, setShowControls] = useState(false);
	const [detail, setDetail] = useState<Rec | null>(null);
	// Run observability (issue #98): a "Runs" section over pipeline-run records.
	const [surface, setSurface] = useState<"records" | "runs">("records");
	const [runs, setRuns] = useState<Run[]>([]);
	const [runsLoading, setRunsLoading] = useState(false);

	const loadCollections = useCallback(async () => {
		try {
			const d = await api<{ collections?: Collection[] }>(`/v1/instances/${instanceId}/collections`);
			const cols = d.collections || [];
			setCollections(cols);
			setSelected((s) => s || cols[0]?.name || "");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load collections");
		}
	}, [instanceId]);

	const loadRecords = useCallback(
		async (name: string) => {
			if (!name) return;
			setLoading(true);
			setError("");
			try {
				const d = await api<{ records?: Rec[] }>(
					`/v1/instances/${instanceId}/collections/${encodeURIComponent(name)}/records?limit=1000`,
				);
				setRecords(d.records || []);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load records");
			}
			setLoading(false);
		},
		[instanceId],
	);

	const loadRuns = useCallback(async () => {
		setRunsLoading(true);
		try {
			const d = await api<{ runs?: Run[] }>(`/v1/instances/${instanceId}/pipeline-runs?limit=100`);
			setRuns(d.runs || []);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load runs");
		}
		setRunsLoading(false);
	}, [instanceId]);

	useEffect(() => {
		loadCollections();
	}, [loadCollections]);
	useEffect(() => {
		if (selected) loadRecords(selected);
	}, [selected, loadRecords]);
	useEffect(() => {
		if (surface === "runs") loadRuns();
	}, [surface, loadRuns]);

	const collection = collections.find((c) => c.name === selected);
	const allColumns = useMemo(
		() => collection?.fields?.map((f) => f.name) ?? (records[0] ? Object.keys(records[0].data) : []),
		[collection, records],
	);
	const baseColumns = useMemo(() => allColumns.filter((c) => c !== "audit"), [allColumns]);
	const columns = useMemo(() => baseColumns.filter((c) => !hidden.has(c)), [baseColumns, hidden]);
	const hasStatus = allColumns.includes("status");

	const facetValues = useMemo(() => {
		const out: Record<string, string[]> = {};
		for (const f of allColumns)
			if (FILTERABLE.has(f)) out[f] = [...new Set(records.map((r) => String(r.data[f] ?? "")).filter(Boolean))].sort();
		return out;
	}, [allColumns, records]);

	const rows = useMemo(() => {
		let out = records;
		for (const [f, v] of Object.entries(filters)) if (v) out = out.filter((r) => String(r.data[f] ?? "") === v);
		if (q.trim()) {
			const needle = q.toLowerCase();
			out = out.filter((r) => allColumns.some((c) => String(r.data[c] ?? "").toLowerCase().includes(needle)));
		}
		if (sortBy) {
			out = [...out].sort((a, b) => {
				const av = String(a.data[sortBy] ?? "");
				const bv = String(b.data[sortBy] ?? "");
				return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
			});
		}
		return out;
	}, [records, filters, q, allColumns, sortBy, sortDir]);

	const toggleSort = (c: string) => {
		if (sortBy === c) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		else {
			setSortBy(c);
			setSortDir("asc");
		}
	};

	const setStatus = async (rec: Rec, status: string) => {
		const prev = rec.data.status;
		setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, data: { ...r.data, status } } : r)));
		try {
			await api(`/v1/instances/${instanceId}/collections/${encodeURIComponent(selected)}/records/${rec.id}`, {
				method: "PUT",
				body: JSON.stringify({ data: { ...rec.data, status } }),
			});
		} catch {
			setRecords((rs) => rs.map((r) => (r.id === rec.id ? { ...r, data: { ...r.data, status: prev } } : r)));
			setError("Failed to save status");
		}
	};

	const exportCsv = () => {
		const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
		const lines = [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r.data[c])).join(","))];
		const blob = new Blob([lines.join("\n")], { type: "text/csv" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${selected}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	const cell = (col: string, val: unknown) => {
		const s = val == null ? "" : String(val);
		if (col === "status" && s) return <Badge value={s} />;
		if (col === "website_status" && s) return <Badge value={s} />;
		if (!s) return <span className="text-muted-soft">—</span>;
		if (DATETIME.has(col)) return <span className="text-muted-soft">{fmtDateTime(s)}</span>;
		if (/^https?:\/\//.test(s))
			return (
				<a href={s} target="_blank" rel="noreferrer" className="text-accent underline">
					{col === "maps_url" ? "Map ↗" : col === "website_url" ? "site ↗" : s}
				</a>
			);
		if (col === "phone")
			return (
				<a href={`tel:${s.replace(/[^0-9+]/g, "")}`} className="text-accent underline">
					{s}
				</a>
			);
		return s;
	};

	// One of these renders per ROW, so a generic "Status" name would announce identically
	// for every record on the page — and this control WRITES: picking an option moves the
	// record's pipeline status immediately. The name has to say which record.
	const StatusSelect = ({ rec }: { rec: Rec }) => (
		<select
			aria-label={`Status of ${String(rec.data.name ?? rec.data.title ?? rec.id ?? "record")}`}
			value={String(rec.data.status ?? "")}
			onChange={(e) => setStatus(rec, e.target.value)}
			className="border rounded text-xs px-1 py-0.5"
		>
			{PIPELINE.map((s) => (
				<option key={s} value={s}>
					{s}
				</option>
			))}
		</select>
	);

	return (
		<div className="text-sm">
			<div className="mb-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="inline-flex rounded border overflow-hidden">
						{(["records", "runs"] as const).map((v) => (
							<button
								key={v}
								type="button"
								onClick={() => setSurface(v)}
								className={`px-2 py-1 text-xs ${surface === v ? "bg-accent text-white" : ""}`}
							>
								{v === "records" ? "Records" : "Runs"}
							</button>
						))}
					</div>
					{surface === "records" && (
					<>
					<select
						aria-label="Collection"
						value={selected}
						onChange={(e) => {
							setSelected(e.target.value);
							setSortBy("");
							setQ("");
							setFilters({});
							setHidden(new Set());
						}}
						className="border rounded px-2 py-1"
					>
						{collections.length === 0 && <option value="">No collections</option>}
						{collections.map((c) => (
							<option key={c.name} value={c.name}>
								{c.name}
								{typeof c.recordCount === "number" ? ` (${c.recordCount})` : ""}
							</option>
						))}
					</select>

					{hasStatus && (
						<div className="inline-flex rounded border overflow-hidden">
							{(["table", "board"] as const).map((v) => (
								<button
									key={v}
									type="button"
									onClick={() => setView(v)}
									className={`px-2 py-1 text-xs ${view === v ? "bg-accent text-white" : ""}`}
								>
									{v === "table" ? "Table" : "Board"}
								</button>
							))}
						</div>
					)}

					<span className="text-muted-soft whitespace-nowrap">
						{rows.length} of {records.length}
					</span>

					<button
						type="button"
						onClick={() => setShowControls((s) => !s)}
						className="border rounded px-2 py-1 text-xs ml-auto"
					>
						{showControls ? "Hide controls ▲" : "Controls ▾"}
					</button>
					</>
					)}
					{surface === "runs" && (
						<button type="button" onClick={loadRuns} className="border rounded px-2 py-1 text-xs ml-auto">
							Refresh
						</button>
					)}
				</div>

				{surface === "records" && showControls && (
					<div className="flex flex-wrap items-center gap-2 mt-2 border-t pt-2">
						<input
							aria-label="Filter records"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="Filter…"
							className="border rounded px-2 py-1 flex-1 min-w-40"
						/>

						{Object.keys(facetValues).map((f) => (
							<select
								key={f}
								aria-label={`Filter by ${f}`}
								value={filters[f] || ""}
								onChange={(e) => setFilters((p) => ({ ...p, [f]: e.target.value }))}
								className="border rounded px-1 py-1 text-xs"
							>
								<option value="">{f}: all</option>
								{facetValues[f].map((v) => (
									<option key={v} value={v}>
										{v}
									</option>
								))}
							</select>
						))}

						<div className="relative">
							<button type="button" onClick={() => setShowCols((s) => !s)} className="border rounded px-2 py-1 text-xs">
								Columns ▾
							</button>
							{showCols && (
								<div className="absolute z-10 mt-1 bg-white border rounded shadow p-2 max-h-64 overflow-auto text-xs">
									{baseColumns.map((c) => (
										<label key={c} className="flex items-center gap-1.5 py-0.5 whitespace-nowrap cursor-pointer">
											<input
												type="checkbox"
												checked={!hidden.has(c)}
												onChange={() =>
													setHidden((h) => {
														const n = new Set(h);
														n.has(c) ? n.delete(c) : n.add(c);
														return n;
													})
												}
											/>
											{c}
										</label>
									))}
								</div>
							)}
						</div>

						<button type="button" onClick={exportCsv} className="border rounded px-2 py-1 text-xs">
							CSV
						</button>
						<button
							type="button"
							onClick={() => {
								loadCollections();
								if (selected) loadRecords(selected);
							}}
							className="border rounded px-2 py-1 text-xs"
						>
							Refresh
						</button>
					</div>
				)}
			</div>

			{error && <div className="text-red-500 mb-2">{error}</div>}

			{surface === "runs" ? (
				runsLoading ? (
					<p className="text-center py-5 text-muted-soft">Loading…</p>
				) : runs.length === 0 ? (
					<p className="text-muted-soft py-5">No pipeline runs yet.</p>
				) : (
					<div className="overflow-auto border rounded">
						<table className="w-full border-collapse">
							<thead>
								<tr>
									{["pipeline", "started", "status", "seen", "added", "skipped", "errors", "trigger"].map((h) => (
										<th key={h} className="text-left px-2 py-1 border-b whitespace-nowrap sticky top-0 bg-white">
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{runs.map((r) => (
									<tr key={r.run_id} className="border-b hover:bg-black/5" title={r.detail || ""}>
										<td className="px-2 py-1 whitespace-nowrap">{r.pipeline}</td>
										<td className="px-2 py-1 whitespace-nowrap text-muted-soft">{fmtDateTime(r.started_at)}</td>
										<td className="px-2 py-1">
											<Badge value={r.status} />
										</td>
										<td className="px-2 py-1 text-right">{r.seen}</td>
										<td className="px-2 py-1 text-right">{r.added}</td>
										<td className="px-2 py-1 text-right">{r.skipped}</td>
										<td className={`px-2 py-1 text-right ${r.errors ? "text-red-600 font-medium" : ""}`}>{r.errors}</td>
										<td className="px-2 py-1 whitespace-nowrap text-muted-soft">{r.trigger}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)
			) : loading ? (
				<p className="text-center py-5 text-muted-soft">Loading…</p>
			) : collections.length === 0 ? (
				<p className="text-muted-soft py-5">This agent has no data collections yet.</p>
			) : view === "board" && hasStatus ? (
				<div className="flex gap-3 overflow-auto pb-2">
					{PIPELINE.map((st) => {
						const cards = rows.filter((r) => String(r.data.status ?? "new") === st);
						return (
							<div key={st} className="min-w-56 flex-1">
								<div className="mb-2 flex items-center gap-2">
									<Badge value={st} />
									<span className="text-muted-soft text-xs">{cards.length}</span>
								</div>
								<div className="flex flex-col gap-2">
									{cards.map((r) => (
										<div key={r.id} className="border rounded p-2 bg-white">
											<div className="font-medium">{cell("name", r.data.name)}</div>
											<div className="text-xs text-muted-soft">
												{[r.data.suburb, r.data.city].filter(Boolean).join(", ")}
											</div>
											{r.data.website_status ? <div className="mt-1">{cell("website_status", r.data.website_status)}</div> : null}
											{r.data.phone ? <div className="text-xs mt-1">{cell("phone", r.data.phone)}</div> : null}
											<div className="mt-1 flex items-center gap-2">
												<StatusSelect rec={r} />
												<button type="button" onClick={() => setDetail(r)} className="text-accent text-xs underline">
													log
												</button>
											</div>
										</div>
									))}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<div className="overflow-auto border rounded">
					<table className="w-full border-collapse">
						<thead>
							<tr>
								<th className="px-1 py-1 border-b sticky top-0 bg-white" />
								{columns.map((c) => (
									<th
										key={c}
										onClick={() => toggleSort(c)}
										className="cursor-pointer text-left px-2 py-1 border-b whitespace-nowrap select-none sticky top-0 bg-white"
									>
										{c}
										{sortBy === c ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id} className="border-b hover:bg-black/5">
									<td className="px-1 py-1 align-top">
										<button type="button" onClick={() => setDetail(r)} title="View audit log" className="text-accent">
											🔍
										</button>
									</td>
									{columns.map((c) => (
										<td key={c} className="px-2 py-1 whitespace-nowrap align-top">
											{c === "status" ? <StatusSelect rec={r} /> : cell(c, r.data[c])}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{detail && (
				// Dismiss-on-backdrop as a real button SIBLING of the panel, not a click handler on
				// the backdrop div wrapping it. Two things fall out: the dismiss becomes reachable by
				// keyboard (a div with onClick is reachable by nothing), and the panel no longer needs
				// `stopPropagation` to avoid closing itself — it is not inside the click target any
				// more. Same idiom as the chat menu's overlay in InstanceDetail.
				<div className="fixed inset-0 flex items-center justify-center z-50 p-4">
					<button type="button" aria-label="Close record details" className="absolute inset-0 bg-black/40 cursor-default" onClick={() => setDetail(null)}>
						<span className="sr-only">Close record details</span>
					</button>
					<div className="relative bg-white rounded shadow-lg max-w-2xl w-full max-h-[85vh] overflow-auto p-4">
						<div className="flex items-center justify-between mb-3">
							<h3 className="font-semibold text-base">{String(detail.data.name ?? detail.data.title ?? detail.id ?? "Record")}</h3>
							<button type="button" aria-label="Close record details" onClick={() => setDetail(null)} className="text-muted-soft">
								✕
							</button>
						</div>
						<table className="text-xs mb-4">
							<tbody>
								{baseColumns.map((c) => (
									<tr key={c}>
										<td className="pr-3 py-0.5 text-muted-soft align-top whitespace-nowrap">{c}</td>
										<td className="py-0.5">{cell(c, detail.data[c])}</td>
									</tr>
								))}
								<tr>
									<td className="pr-3 py-0.5 text-muted-soft align-top">created</td>
									<td className="py-0.5">{fmtDateTime(detail.createdAt)}</td>
								</tr>
							</tbody>
						</table>
						<h4 className="font-semibold text-sm mb-2">Audit trail — what the agent did</h4>
						<ol className="text-xs space-y-2">
							{/* The index IS the identity here, so keying by it is correct rather than tolerated:
							    this is an append-only audit trail on ONE already-fetched record, rendered in the
							    order the agent wrote it. Nothing reorders, inserts, removes or filters it, and no
							    row holds state of its own — the failure the rule warns about (React reusing a
							    node whose state belongs to a different item) has no way to occur. A synthetic id
							    would only be the index under another name. */}
							{(Array.isArray(detail.data.audit) ? (detail.data.audit as Array<Record<string, string>>) : []).map((s, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: an append-only trail on an immutable record — position IS the step's identity.
								<li key={i} className="border-l-2 border-accent/40 pl-2">
									<div className="font-medium">{s.step}</div>
									<div className="text-muted-soft">{s.detail}</div>
									{s.at ? <div className="text-muted-soft">{fmtDateTime(s.at)}</div> : null}
								</li>
							))}
						</ol>
					</div>
				</div>
			)}
		</div>
	);
}
