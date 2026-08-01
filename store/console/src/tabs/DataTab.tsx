import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";

// A spreadsheet view over an agent's structured collections: pick a collection,
// filter/sort its records, and see them as a table. Columns come from the
// collection's field schema; url/phone cells render as clickable links.

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
				const d = await api<{ records?: Rec[]; total?: number }>(
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
	const columns = useMemo(
		() => collection?.fields?.map((f) => f.name) ?? (records[0] ? Object.keys(records[0].data) : []),
		[collection, records],
	);

	const rows = useMemo(() => {
		let out = records;
		if (q.trim()) {
			const needle = q.toLowerCase();
			out = out.filter((r) => columns.some((c) => String(r.data[c] ?? "").toLowerCase().includes(needle)));
		}
		if (sortBy) {
			out = [...out].sort((a, b) => {
				const av = String(a.data[sortBy] ?? "");
				const bv = String(b.data[sortBy] ?? "");
				return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
			});
		}
		return out;
	}, [records, q, columns, sortBy, sortDir]);

	const toggleSort = (c: string) => {
		if (sortBy === c) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		else {
			setSortBy(c);
			setSortDir("asc");
		}
	};

	const renderCell = (col: string, val: unknown) => {
		const s = val == null ? "" : String(val);
		if (!s) return <span className="text-muted-soft">—</span>;
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

	return (
		<div className="text-sm">
			<div className="flex flex-wrap items-center gap-2 mb-3">
				<select
					value={selected}
					onChange={(e) => {
						setSelected(e.target.value);
						setSortBy("");
						setQ("");
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
				<input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Filter…"
					className="border rounded px-2 py-1 flex-1 min-w-40"
				/>
				<span className="text-muted-soft whitespace-nowrap">
					{rows.length} of {records.length}
				</span>
				<button
					type="button"
					onClick={() => {
						loadCollections();
						if (selected) loadRecords(selected);
					}}
					className="border rounded px-2 py-1"
				>
					Refresh
				</button>
			</div>

			{error && <div className="text-red-500 mb-2">{error}</div>}

			{loading ? (
				<p className="text-center py-5 text-muted-soft">Loading…</p>
			) : collections.length === 0 ? (
				<p className="text-muted-soft py-5">This agent has no data collections yet.</p>
			) : (
				<div className="overflow-auto border rounded">
					<table className="w-full border-collapse">
						<thead>
							<tr>
								{columns.map((c) => (
									<th
										key={c}
										onClick={() => toggleSort(c)}
										className="cursor-pointer text-left px-2 py-1 border-b whitespace-nowrap select-none"
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
											{renderCell(c, r.data[c])}
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
