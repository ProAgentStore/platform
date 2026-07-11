/**
 * The Knowledge tab's Index sub-tab: what is actually in the instance's vector
 * store (per-source chunk counts from GET /vectors) plus a live "test search"
 * that runs the SAME semantic search the agent uses at chat time — so a user
 * can see what's indexed and debug "why didn't it know X" without chatting.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";

interface VectorSource {
	sourceType: "knowledge" | "message" | "file" | "collection" | "repo";
	sourceId: string;
	name: string;
	chunks: number;
	chars: number;
	lastIndexed: string;
	preview: string;
}

interface VectorStats {
	totalSources: number;
	totalChunks: number;
	totalChars: number;
	sources: VectorSource[];
}

interface SearchHit {
	score: number;
	text: string;
	sourceType: VectorSource["sourceType"];
	sourceId: string;
}

const TYPE_LABEL: Record<VectorSource["sourceType"], string> = {
	knowledge: "Document",
	file: "File",
	repo: "Repo",
	message: "Conversation",
	collection: "Collection",
};

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

export default function VectorsSection({ instanceId, active }: { instanceId: string; active: boolean }) {
	const [stats, setStats] = useState<VectorStats | null>(null);
	const [loading, setLoading] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);

	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const [showAll, setShowAll] = useState(false);
	const [searchError, setSearchError] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const d = await api<VectorStats>(`/v1/instances/${instanceId}/vectors`);
			setStats(d);
		} catch {}
		setLoading(false);
	}, [instanceId]);

	useEffect(() => {
		if (active) load();
	}, [active, load]);

	const runSearch = async () => {
		if (!query.trim() || searching) return;
		setSearching(true);
		setSearchError("");
		setShowAll(false);
		try {
			// 20 = the Vectorize cap with full metadata; a search costs the same
			// regardless of top_k, so always fetch the max and expand on demand.
			const d = await api<{ results: SearchHit[] }>(`/v1/instances/${instanceId}/search`, {
				method: "POST",
				body: JSON.stringify({ query: query.trim(), top_k: 20 }),
			});
			setHits(d.results || []);
		} catch (e) {
			setHits(null);
			setSearchError(e instanceof Error ? e.message : String(e));
		}
		setSearching(false);
	};

	const nameFor = (hit: SearchHit) =>
		stats?.sources.find((s) => s.sourceType === hit.sourceType && s.sourceId === hit.sourceId)?.name || hit.sourceId;

	return (
		<div>
			<div className="flex justify-between items-center gap-2 mb-3">
				<h3 className="text-base font-bold">Search index</h3>
				<button type="button" onClick={load} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold">
					Refresh
				</button>
			</div>

			<p className="text-xs text-muted mb-3">
				Everything below is embedded in the agent's vector store and retrieved by meaning when you chat. Use the test search to see exactly what the agent finds for a question.
			</p>

			{/* Two columns on desktop: inventory left, test search riding co-pilot on the
			    right (sticky). Width-capped so the search panel (and its Search button)
			    never hugs the far screen edge on very wide windows. Mobile stacks:
			    search first — it's the tool, not the list. */}
			<div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] gap-4 items-start max-w-[1200px]">
				<div className="order-2 lg:order-1 min-w-0">
					{/* Stat chips */}
					{stats && (
						<div className="flex flex-wrap gap-2 mb-3">
							<span className="text-xs px-2.5 py-1 rounded-full bg-panel border border-line"><b>{stats.totalSources}</b> source{stats.totalSources === 1 ? "" : "s"}</span>
							<span className="text-xs px-2.5 py-1 rounded-full bg-panel border border-line"><b>{stats.totalChunks}</b> chunk{stats.totalChunks === 1 ? "" : "s"}</span>
							<span className="text-xs px-2.5 py-1 rounded-full bg-panel border border-line"><b>{fmtChars(stats.totalChars)}</b> chars indexed</span>
						</div>
					)}

					{/* Inventory */}
					{loading && !stats ? (
						<p className="text-center py-4 text-muted-soft text-sm">Loading…</p>
					) : !stats || stats.sources.length === 0 ? (
						<p className="text-center py-4 text-muted-soft text-sm">Nothing indexed yet — add documents or upload files and they become searchable here.</p>
					) : (
						<div className="flex flex-col gap-2">
							{stats.sources.map((s) => {
								const key = `${s.sourceType}:${s.sourceId}`;
								return (
									<div key={key} className="bg-panel border border-line rounded-lg p-3">
										<button type="button" onClick={() => setExpanded(expanded === key ? null : key)} className="w-full flex justify-between items-center gap-3 text-left">
											<span className="text-sm font-semibold truncate">{s.name}</span>
											<span className="text-xs text-muted shrink-0">
												{TYPE_LABEL[s.sourceType] || s.sourceType} · {s.chunks} chunk{s.chunks === 1 ? "" : "s"} · {fmtChars(s.chars)} chars
											</span>
										</button>
										{expanded === key && (
											<div className="mt-2 pt-2 border-t border-line">
												{s.lastIndexed && <div className="text-xs text-muted-soft mb-1">Indexed {new Date(s.lastIndexed).toLocaleString()}</div>}
												<p className="text-xs text-muted whitespace-pre-wrap">{s.preview}…</p>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Test search — the co-pilot column */}
				<div className="order-1 lg:order-2 min-w-0 lg:sticky lg:top-16 bg-panel border border-line rounded-lg p-3">
					<div className="flex gap-2">
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
							placeholder="Test what the agent can find, e.g. “ice machine capacity”"
							className="flex-1 bg-bg border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
						/>
						<button type="button" onClick={runSearch} disabled={searching || !query.trim()} className="text-xs px-3 py-2 rounded-lg bg-accent text-white font-bold disabled:opacity-50">
							{searching ? "Searching…" : "Search"}
						</button>
					</div>
					{searchError && <div className="text-xs text-red mt-2">{searchError}</div>}
					{hits && (
						<div className="flex flex-col gap-2 mt-3 lg:max-h-[60vh] lg:overflow-y-auto">
							{hits.length === 0 && <p className="text-xs text-muted-soft">No matches — this content may not be indexed.</p>}
							{(showAll ? hits : hits.slice(0, 5)).map((h, i) => (
								<div key={i} className="border border-line rounded-lg p-2.5">
									<div className="flex justify-between items-center gap-2 mb-1">
										<span className="text-xs font-semibold truncate">#{i + 1} · {nameFor(h)}</span>
										<span className="text-xs text-muted shrink-0">{TYPE_LABEL[h.sourceType] || h.sourceType} · {Math.round(h.score * 100)}% match</span>
									</div>
									<div className="h-1 bg-line rounded-full overflow-hidden mb-1.5">
										<div className="h-full bg-accent rounded-full" style={{ width: `${Math.round(h.score * 100)}%` }} />
									</div>
									<p className="text-xs text-muted line-clamp-3">{h.text}</p>
								</div>
							))}
							{hits.length > 5 && (
								<button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold self-start">
									{showAll ? "Show top 5" : `Show ${hits.length - 5} more matches`}
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
