import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../components/Button";
import PipelineRunDetails from "../components/PipelineRunDetails";
import { statusBadgeClass } from "../lib/statusBadge";
import { runHasErrors, type Run } from "../lib/pipelineRuns";
import type { DataRecord, RecordQueryResponse } from "../lib/types";

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
type Rec = DataRecord;

const PIPELINE = ["new", "contacted", "won", "dead"];
const FILTERABLE = new Set(["status", "country", "state", "city", "suburb", "website_status"]);
const DATETIME = new Set(["found_at", "checked_at", "created_at", "createdAt", "updatedAt"]);
const PAGE_SIZES = [25, 50, 100] as const;
const SYSTEM_COLUMNS = ["createdAt", "updatedAt"] as const;

function columnLabel(column: string): string {
	if (column === "createdAt") return "Added";
	if (column === "updatedAt") return "Updated";
	return column;
}

function Badge({ value }: { value: string }) {
	return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass(value)}`}>{value}</span>;
}

function fmtDateTime(v: unknown): string {
	if (v == null || v === "") return "";
	// Accept ms-epoch numbers (pipeline run timestamps) as well as date strings.
	const d = typeof v === "number" ? new Date(v) : new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function Pagination({
	page,
	pageCount,
	pageSize,
	onPageChange,
	onPageSizeChange,
}: {
	page: number;
	pageCount: number;
	pageSize: (typeof PAGE_SIZES)[number];
	onPageChange: (page: number) => void;
	onPageSizeChange: (size: (typeof PAGE_SIZES)[number]) => void;
}) {
	return (
		<nav aria-label="Record pages" className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs">
			<label className="flex items-center gap-1.5 text-muted-soft">
				Rows per page
				<select
					aria-label="Rows per page"
					value={pageSize}
					onChange={(event) => onPageSizeChange(Number(event.target.value) as (typeof PAGE_SIZES)[number])}
					className="border border-line rounded px-1 py-1 bg-panel text-ink"
				>
					{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
				</select>
			</label>
			<div className="flex items-center gap-1.5">
				<Button size="sm" onClick={() => onPageChange(0)} disabled={page === 0} aria-label="First page">«</Button>
				<Button size="sm" onClick={() => onPageChange(page - 1)} disabled={page === 0}>Previous</Button>
				<span className="text-muted-soft whitespace-nowrap" aria-live="polite">Page {page + 1} of {pageCount}</span>
				<Button size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount - 1}>Next</Button>
				<Button size="sm" onClick={() => onPageChange(pageCount - 1)} disabled={page >= pageCount - 1} aria-label="Last page">»</Button>
			</div>
		</nav>
	);
}

export default function DataTab({ instanceId }: { instanceId: string }) {
	const [collections, setCollections] = useState<Collection[]>([]);
	const [selected, setSelected] = useState("");
	const [records, setRecords] = useState<Rec[]>([]);
	const [totalRecords, setTotalRecords] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [sortBy, setSortBy] = useState("");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(50);
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
	const [openRun, setOpenRun] = useState<string | null>(null);
	const recordsRequest = useRef(0);

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
		async (name: string, requestPage: number, requestPageSize: number, requestFilters: Record<string, string>, requestSortBy: string, requestSortDir: "asc" | "desc") => {
			if (!name) return;
			const request = ++recordsRequest.current;
			setLoading(true);
			setError("");
			try {
				const query = new URLSearchParams({
					limit: String(requestPageSize),
					offset: String(requestPage * requestPageSize),
				});
				const where = Object.fromEntries(Object.entries(requestFilters).filter(([, value]) => value));
				if (Object.keys(where).length) query.set("where", JSON.stringify(where));
				if (requestSortBy) {
					query.set("order_by", requestSortBy);
					query.set("order_dir", requestSortDir);
				}
				const d = await api<RecordQueryResponse>(
					`/v1/instances/${instanceId}/collections/${encodeURIComponent(name)}/records?${query}`,
				);
				if (request === recordsRequest.current) {
					setRecords(d.records || []);
					setTotalRecords(d.total ?? 0);
				}
			} catch (e) {
				if (request === recordsRequest.current) setError(e instanceof Error ? e.message : "Failed to load records");
			}
			if (request === recordsRequest.current) setLoading(false);
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
		if (selected) loadRecords(selected, page, pageSize, filters, sortBy, sortDir);
	}, [selected, page, pageSize, filters, sortBy, sortDir, loadRecords]);
	useEffect(() => {
		if (surface === "runs") loadRuns();
	}, [surface, loadRuns]);

	const collection = collections.find((c) => c.name === selected);
	const allColumns = useMemo(
		() => collection?.fields?.map((f) => f.name) ?? (records[0] ? Object.keys(records[0].data) : []),
		[collection, records],
	);
	// Creation/update time is record metadata rather than user-supplied collection data. Keep it
	// in the spreadsheet so an operator can see when a lead arrived and last changed, while still
	// letting them hide either column through the regular Columns menu.
	const baseColumns = useMemo(
		() => [...SYSTEM_COLUMNS, ...allColumns.filter((c) => c !== "audit" && !SYSTEM_COLUMNS.includes(c as (typeof SYSTEM_COLUMNS)[number]))],
		[allColumns],
	);
	const columns = useMemo(() => baseColumns.filter((c) => !hidden.has(c)), [baseColumns, hidden]);
	const hasStatus = allColumns.includes("status");

	const facetValues = useMemo(() => {
		const out: Record<string, string[]> = {};
		for (const f of allColumns)
			if (FILTERABLE.has(f)) out[f] = [...new Set(records.map((r) => String(r.data[f] ?? "")).filter(Boolean))].sort();
		return out;
	}, [allColumns, records]);

	const rows = records;

	const toggleSort = (c: string) => {
		setPage(0);
		if (sortBy === c) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		else {
			setSortBy(c);
			setSortDir("asc");
		}
	};
	const updateFilter = (field: string, value: string) => {
		setFilters((current) => ({ ...current, [field]: value }));
		setPage(0);
	};
	const clearFilters = () => {
		setFilters({});
		setPage(0);
	};
	const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
	const firstRecord = totalRecords === 0 ? 0 : page * pageSize + 1;
	const lastRecord = Math.min((page + 1) * pageSize, totalRecords);
	const hasActiveFilters = Object.values(filters).some(Boolean);
	const recordValue = (record: Rec, column: string): unknown =>
		column === "createdAt" ? record.createdAt : column === "updatedAt" ? record.updatedAt : record.data[column];

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
		const lines = [columns.map((c) => esc(columnLabel(c))).join(","), ...rows.map((r) => columns.map((c) => esc(recordValue(r, c))).join(","))];
		const blob = new Blob([lines.join("\n")], { type: "text/csv" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${selected}-page-${page + 1}.csv`;
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
			className="border border-line rounded text-xs px-1 py-0.5"
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
					<div className="inline-flex rounded border border-line overflow-hidden">
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
							setFilters({});
							setHidden(new Set());
							setPage(0);
						}}
						className="border border-line rounded px-2 py-1"
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
						<div className="inline-flex rounded border border-line overflow-hidden">
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

					<span className="text-muted-soft whitespace-nowrap" aria-live="polite">
						{totalRecords === 0 ? "No records" : `${firstRecord}–${lastRecord} of ${totalRecords}`}
					</span>

					<Button size="sm" onClick={() => setShowControls((s) => !s)} className="ml-auto">
						{showControls ? "Hide filters & columns ▲" : "Filters & columns ▾"}
					</Button>
					</>
					)}
					{surface === "runs" && (
						<Button size="sm" onClick={loadRuns} className="ml-auto">Refresh</Button>
					)}
				</div>

				{surface === "records" && showControls && (
					<div className="flex flex-wrap items-center gap-2 mt-2 border-t border-line pt-2">
						{Object.keys(facetValues).map((f) => (
							<select
								key={f}
								aria-label={`Filter by ${f}`}
								value={filters[f] || ""}
								onChange={(e) => updateFilter(f, e.target.value)}
								className="border border-line rounded px-1 py-1 text-xs"
							>
								<option value="">{f}: all</option>
								{facetValues[f].map((v) => (
									<option key={v} value={v}>
										{v}
									</option>
								))}
							</select>
						))}
						{hasActiveFilters && <Button size="sm" onClick={clearFilters}>Clear filters</Button>}

						<div className="relative">
							<Button size="sm" onClick={() => setShowCols((s) => !s)}>Columns ▾</Button>
							{showCols && (
								<div className="absolute z-10 mt-1 bg-panel border border-line rounded shadow p-2 max-h-64 overflow-auto text-xs">
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
											{columnLabel(c)}
										</label>
									))}
								</div>
							)}
						</div>

						<Button size="sm" onClick={exportCsv} disabled={records.length === 0}>Export page CSV</Button>
						<Button
							size="sm"
							onClick={() => {
								loadCollections();
								if (selected) loadRecords(selected, page, pageSize, filters, sortBy, sortDir);
							}}
						>
							Refresh
						</Button>
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
					<div className="overflow-auto border border-line rounded">
						<table className="w-full border-collapse">
							<caption className="sr-only">Pipeline runs</caption>
							<thead>
								<tr>
									<th scope="col" className="px-1 py-1 border-b border-line sticky top-0 bg-panel"><span className="sr-only">Run details</span></th>
									{["pipeline", "started", "status", "seen", "added", "skipped", "errors", "trigger"].map((h) => (
										<th key={h} scope="col" className="text-left px-2 py-1 border-b border-line whitespace-nowrap sticky top-0 bg-panel">
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{runs.map((r) => (
									<Fragment key={r.run_id}>
									<tr className="border-b border-line hover:bg-panel">
										<td className="px-1 py-1">
											{/* The detail used to live in this row's `title` — reachable by mouse hover only, and
											    only the terminal line of it. A real control opens the whole record (#834). */}
											<button
												type="button"
												aria-expanded={openRun === r.run_id}
												aria-controls={`run-details-${r.run_id}`}
												aria-label={`${openRun === r.run_id ? "Hide" : "Show"} details for ${r.pipeline} run started ${fmtDateTime(r.started_at)}`}
												onClick={() => setOpenRun((o) => (o === r.run_id ? null : r.run_id))}
												className="text-accent text-xs underline whitespace-nowrap"
											>
												{runHasErrors(r) ? "Errors" : "Details"} {openRun === r.run_id ? "▲" : "▾"}
											</button>
										</td>
										<td className="px-2 py-1 whitespace-nowrap">{r.pipeline}</td>
										<td className="px-2 py-1 whitespace-nowrap text-muted-soft">{fmtDateTime(r.started_at)}</td>
										<td className="px-2 py-1">
											<Badge value={r.status} />
										</td>
										<td className="px-2 py-1 text-right">{r.seen}</td>
										<td className="px-2 py-1 text-right">{r.added}</td>
										<td className="px-2 py-1 text-right">{r.skipped}</td>
										<td className={`px-2 py-1 text-right ${r.errors ? "text-danger font-medium" : ""}`}>{r.errors}</td>
										<td className="px-2 py-1 whitespace-nowrap text-muted-soft">{r.trigger}</td>
									</tr>
									{openRun === r.run_id && (
										<tr id={`run-details-${r.run_id}`} className="border-b border-line bg-panel">
											<td colSpan={9}>
												<PipelineRunDetails instanceId={instanceId} run={r} fmtDateTime={fmtDateTime} />
											</td>
										</tr>
									)}
									</Fragment>
								))}
							</tbody>
						</table>
					</div>
				)
			) : loading ? (
				<p className="text-center py-5 text-muted-soft">Loading…</p>
			) : collections.length === 0 ? (
				<p className="text-muted-soft py-5">This agent has no data collections yet.</p>
			) : totalRecords === 0 ? (
				<p className="text-muted-soft py-5">{hasActiveFilters ? "No records match these filters." : "No records in this collection yet."}</p>
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
										<div key={r.id} className="border border-line rounded p-2 bg-panel">
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
				<div className="overflow-auto border border-line rounded">
					<table className="w-full border-collapse">
						<caption className="sr-only">{selected} records</caption>
						<thead>
							<tr>
								<th scope="col" className="px-1 py-1 border-b border-line sticky top-0 bg-panel"><span className="sr-only">Record details</span></th>
								{columns.map((c) => (
									<th
										key={c}
										scope="col"
										aria-sort={sortBy === c ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
										className="text-left px-2 py-1 border-b border-line whitespace-nowrap sticky top-0 bg-panel"
									>
										<button type="button" onClick={() => toggleSort(c)} className="cursor-pointer select-none text-left">
											{columnLabel(c)}
											{sortBy === c ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
										</button>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.id} className="border-b border-line hover:bg-panel">
									<td className="px-1 py-1 align-top">
										<button type="button" onClick={() => setDetail(r)} title="View record details" aria-label={`View details for ${String(r.data.name ?? r.data.title ?? r.id)}`} className="text-accent">
											🔍
										</button>
									</td>
									{columns.map((c) => (
										<td key={c} className="px-2 py-1 whitespace-nowrap align-top">
											{c === "status" ? <StatusSelect rec={r} /> : cell(c, recordValue(r, c))}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{surface === "records" && !loading && totalRecords > 0 && (
				<Pagination
					page={page}
					pageCount={pageCount}
					pageSize={pageSize}
					onPageChange={setPage}
					onPageSizeChange={(size) => {
						setPageSize(size);
						setPage(0);
					}}
				/>
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
					<div className="relative bg-panel rounded shadow-lg max-w-2xl w-full max-h-[85vh] overflow-auto p-4">
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
										<td className="pr-3 py-0.5 text-muted-soft align-top whitespace-nowrap">{columnLabel(c)}</td>
										<td className="py-0.5">{cell(c, recordValue(detail, c))}</td>
									</tr>
								))}
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
