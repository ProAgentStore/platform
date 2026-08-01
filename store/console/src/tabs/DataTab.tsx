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
};

function Badge({ value }: { value: string }) {
	const cls = STATUS_CLASS[value] || "bg-gray-100 text-gray-600";
	return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{value}</span>;
}

function fmtDateTime(v: unknown): string {
	const s = String(v ?? "");
	if (!s) return "";
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
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

	useEffect(() => {
		loadCollections();
	}, [loadCollections]);
	useEffect(() => {
		if (selected) loadRecords(selected);
	}, [selected, loadRecords]);

	const collection = collections.find((c) => c.name === selected);
	const allColumns = useMemo(
		() => collection?.fields?.map((f) => f.name) ?? (records[0] ? Object.keys(records[0].data) : []),
		[collection, records],
	);
	const columns = useMemo(() => allColumns.filter((c) => !hidden.has(c)), [allColumns, hidden]);
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

	const StatusSelect = ({ rec }: { rec: Rec }) => (
		<select
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
					<select
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
				</div>

				{showControls && (
					<div className="flex flex-wrap items-center gap-2 mt-2 border-t pt-2">
						<input
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder="Filter…"
							className="border rounded px-2 py-1 flex-1 min-w-40"
						/>

						{Object.keys(facetValues).map((f) => (
							<select
								key={f}
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
									{allColumns.map((c) => (
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

			{loading ? (
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
											<div className="mt-1">
												<StatusSelect rec={r} />
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
		</div>
	);
}
