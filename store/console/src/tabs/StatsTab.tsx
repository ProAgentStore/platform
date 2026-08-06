import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { LineChart, Plus, RefreshCw } from "lucide-react";
import StatsCard from "../components/StatsCard";
import { historyNote, throughDayNote, windowLabel } from "../lib/stats-format";
import type { StatsCardKind, StatsRejection, StatsResponse, StatsSourceInfo, StatsSourcesResponse } from "../lib/stats-types";

/**
 * Stats tab (#311) — what the agent shows about itself.
 *
 * ## Everything on this page is served, not restated
 *
 * The source list, the kinds each source can fill, its params and — above all — its CAVEAT come
 * from `GET /v1/stats/sources`. The console renders those strings verbatim. A copy here would
 * drift, and the thing that drifts is the sentence saying what a number does not count.
 *
 * ## Three page-level disclosures, stated once
 *
 * `throughDay` (today is deliberately absent from every trend) and `historyStart` (there is no
 * backfill, so a short series is a young rollup rather than an idle agent) are facts about the
 * whole view, so they are stated once at the top rather than twelve times on twelve cards. Gaps
 * are per-card and stated on the card.
 *
 * ## The window is page-level on purpose
 *
 * One selector, one query set — #310 made this a page-level concern so the API is asked for one
 * coherent view. Per-card windows would be twelve independent aggregate reads on a tab someone
 * leaves open.
 */

const WINDOWS = [7, 30, 90] as const;

export default function StatsTab({ instanceId }: { instanceId: string }) {
	const [windowDays, setWindowDays] = useState<number>(30);
	const [data, setData] = useState<StatsResponse | null>(null);
	const [sources, setSources] = useState<StatsSourceInfo[]>([]);
	const [maxCards, setMaxCards] = useState(12);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [rejected, setRejected] = useState<StatsRejection[]>([]);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	// A plain counter, so "reload" is a primitive dependency rather than a new function identity
	// on every render. Deps here are all primitives deliberately — an array or object dep on this
	// page would re-fire the effect every render, and "fix" the lint by breaking the page (#309).
	const [nonce, setNonce] = useState(0);

	/**
	 * Load the values for ONE window, with a stale-response guard.
	 *
	 * #240 is the precedent: switching agents left the previous instance's data on screen, and a
	 * save then wrote it to the wrong agent. Both halves are used — `AbortController` stops the
	 * in-flight request, and `live` stops a response that had already resolved from landing in the
	 * new instance's state. The surface is keyed by instance now, but a tab whose fetch is slower
	 * than a tab switch still wants the belt as well as the braces.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a trigger, not an input — Refresh and every save bump it so this effect re-runs for the SAME instance and window. Taking the "remove the extra dependency" fix makes both controls silently inert, and the lint is not always right here: following it on two InstanceDetail memos swapped value deps for identity deps and killed every instance tab in production.
	useEffect(() => {
		let live = true;
		const ctl = new AbortController();
		setLoading(true);
		(async () => {
			try {
				const res = await api<StatsResponse>(`/v1/instances/${instanceId}/stats?window=${windowDays}`, { signal: ctl.signal });
				if (!live) return;
				setData(res);
				setError("");
			} catch (e) {
				if (!live || ctl.signal.aborted) return;
				setData(null);
				setError(e instanceof Error ? e.message : "Could not load stats");
			} finally {
				if (live) setLoading(false);
			}
		})();
		return () => {
			live = false;
			ctl.abort();
		};
	}, [instanceId, windowDays, nonce]);

	// The source catalog is static product description — fetched once, not per window.
	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const res = await api<StatsSourcesResponse>("/v1/stats/sources");
				if (!live) return;
				setSources(res.sources || []);
				setMaxCards(res.maxCards || 12);
			} catch {
				// Non-fatal: cards still render (their caveat travels with them). Only the "add a
				// card" picker needs this, and it says so when it is empty.
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	const sourceLabels = useMemo(() => new Map(sources.map((s) => [s.id, s.label])), [sources]);

	const patch = useCallback(
		async (ops: Array<{ id: string; card: unknown | null }>) => {
			setBusy(true);
			setRejected([]);
			try {
				const res = await api<{ rejected?: StatsRejection[] }>(`/v1/instances/${instanceId}/stats/cards`, {
					method: "POST",
					body: JSON.stringify({ ops }),
				});
				// Shown, never swallowed. A card that silently vanishes looks like a save that worked.
				if (res.rejected?.length) setRejected(res.rejected);
				setNonce((n) => n + 1);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Could not save");
			} finally {
				setBusy(false);
			}
		},
		[instanceId],
	);

	const cards = data?.cards ?? [];
	const history = data ? historyNote(data.historyStart, data.throughDay, data.window) : null;
	const hasTrend = cards.some((c) => c.family === "trend");
	const atLimit = cards.length >= maxCards;

	return (
		<div className="max-w-4xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="text-lg font-semibold flex items-center gap-2">
						<LineChart size={18} className="text-accent" /> Stats
					</h2>
					<p className="text-sm text-muted mt-1">
						What this agent tracks about its own work. Each card names a source; the sentence under it says what that number
						does not count.
					</p>
				</div>
				<button
					type="button"
					onClick={() => setNonce((n) => n + 1)}
					className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent shrink-0"
				>
					<RefreshCw size={13} /> Refresh
				</button>
			</div>

			{/* One page-level window — never one per card. */}
			<div className="flex flex-wrap gap-1">
				{WINDOWS.map((w) => (
					<button
						key={w}
						type="button"
						onClick={() => setWindowDays(w)}
						className={`text-xs px-3 py-1.5 rounded-lg border font-semibold transition-colors ${
							windowDays === w ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink"
						}`}
					>
						{windowLabel(w)}
					</button>
				))}
				{/* The previous window's cards stay on screen while the new ones load, so say that
				    they are the old ones rather than letting them read as the answer. */}
				{loading && data && <span className="text-xs text-muted-soft self-center ml-1">updating…</span>}
			</div>

			{/* Page-level disclosures. Only shown once there is a trend on screen to explain. */}
			{data && hasTrend && (
				<div className="text-xs text-muted-soft space-y-1">
					<p>{throughDayNote(data.throughDay)}</p>
					{history && <p className="text-yellow/90">{history}</p>}
				</div>
			)}

			{error && <div className="text-sm text-red">{error}</div>}

			{rejected.length > 0 && (
				<div className="text-xs text-red border border-red/40 rounded-lg p-2">
					<div className="font-semibold">Not saved:</div>
					<ul>
						{rejected.map((r) => (
							<li key={`${r.index}-${r.id ?? ""}`}>
								{r.id ? `${r.id}: ` : ""}
								{r.reason}
							</li>
						))}
					</ul>
				</div>
			)}

			{loading && !data ? (
				<p className="text-sm text-muted py-6">Loading…</p>
			) : !data ? (
				// The load FAILED (the reason is in red above). Not the empty state: "this agent
				// tracks nothing" and "we could not ask" are different claims, and showing the
				// former for the latter is the same mistake at page level that an empty chart on a
				// failed card would be at card level.
				<p className="text-sm text-muted-soft py-6">Nothing is shown because the request failed — not because this agent tracks nothing.</p>
			) : cards.length === 0 ? (
				<EmptyState onAdd={() => setAdding(true)} canAdd={sources.length > 0} />
			) : (
				<div className="grid gap-3 sm:grid-cols-2">
					{cards.map((card) => (
						<StatsCard
							key={card.id}
							card={card}
							sourceLabel={sourceLabels.get(card.source)}
							busy={busy}
							onRemove={() => void patch([{ id: card.id, card: null }])}
						/>
					))}
				</div>
			)}

			{sources.length > 0 &&
				(adding ? (
					<AddCard sources={sources} busy={busy} onCancel={() => setAdding(false)} onAdd={(card) => void patch([{ id: card.id, card }]).then(() => setAdding(false))} />
				) : (
					cards.length > 0 && (
						<button
							type="button"
							disabled={atLimit}
							onClick={() => setAdding(true)}
							className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent disabled:opacity-40"
							title={atLimit ? `You already have the maximum of ${maxCards} cards.` : undefined}
						>
							<Plus size={13} /> {atLimit ? `Maximum ${maxCards} cards` : "Add a card"}
						</button>
					)
				))}
		</div>
	);
}

/**
 * The empty state is load-bearing (#310 dropped the platform-default cards).
 *
 * A freshly subscribed agent has zero cards, so an empty page is the FIRST thing most people see
 * here. It has to say what the tab is for and how to fill it — including the honest shortcut, that
 * `set_stats_card` is base-tier so the agent itself can add a card when asked in chat.
 */
function EmptyState({ onAdd, canAdd }: { onAdd: () => void; canAdd: boolean }) {
	return (
		<div className="text-center py-10 px-4 bg-panel border border-line rounded-xl">
			<LineChart size={28} className="mx-auto text-muted-soft mb-2" />
			<div className="font-semibold text-sm">No stats cards yet</div>
			<p className="text-sm text-muted mt-1 max-w-md mx-auto">
				Cards show what this agent is doing — runs, spend, board items, or the size of a collection it fills. Nothing is
				tracked until you add one.
			</p>
			<p className="text-sm text-muted-soft mt-2 max-w-md mx-auto">
				You can also just ask the agent in chat — “track how many leads you find each day” — and it will add the card
				itself.
			</p>
			{canAdd && (
				<button
					type="button"
					onClick={onAdd}
					className="mt-3 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-accent text-accent font-semibold"
				>
					<Plus size={13} /> Add a card
				</button>
			)}
		</div>
	);
}

/** `Sydney Leads` → `sydney-leads`, matching the server's card-id shape. */
export function slugifyCardId(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 28);
	return `${base || "card"}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The card picker — entirely derived from the served catalog.
 *
 * Kinds come from `source.kinds` and inputs from `source.params`, so a new source or a new kind
 * appears here with no console change. The server validates again anyway and names what it
 * refused; this only avoids offering combinations it is known to reject.
 */
function AddCard({
	sources,
	busy,
	onAdd,
	onCancel,
}: {
	sources: StatsSourceInfo[];
	busy: boolean;
	onAdd: (card: { id: string; title: string; kind: StatsCardKind; source: string; params: Record<string, string | number> }) => void;
	onCancel: () => void;
}) {
	const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
	const source = sources.find((s) => s.id === sourceId) ?? sources[0];
	const [kind, setKind] = useState<StatsCardKind>(source?.kinds[0] ?? "number");
	const [title, setTitle] = useState(source?.label ?? "");
	const [params, setParams] = useState<Record<string, string>>({});

	const pickSource = (id: string) => {
		const next = sources.find((s) => s.id === id);
		setSourceId(id);
		setParams({});
		if (next) {
			setKind(next.kinds[0]);
			setTitle(next.label);
		}
	};

	if (!source) return null;
	const missing = source.params.filter((p) => p.required && !params[p.id]?.trim());

	return (
		<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 space-y-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="text-xs text-muted">
					Source
					<select
						className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1.5 text-sm text-ink"
						value={sourceId}
						onChange={(e) => pickSource(e.target.value)}
					>
						{sources.map((s) => (
							<option key={s.id} value={s.id} className="bg-panel">
								{s.label}
							</option>
						))}
					</select>
				</label>
				<label className="text-xs text-muted">
					Shown as
					<select
						className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1.5 text-sm text-ink"
						value={kind}
						onChange={(e) => setKind(e.target.value as StatsCardKind)}
					>
						{source.kinds.map((k) => (
							<option key={k} value={k} className="bg-panel">
								{k === "line" ? "Daily trend (line)" : k}
							</option>
						))}
					</select>
				</label>
			</div>

			{/* What it counts, and what it does not — both shown BEFORE the card is created, not
			    discovered afterwards. */}
			<p className="text-xs text-muted">{source.describes}</p>
			<p className="text-[0.7rem] text-muted-soft">{source.caveat}</p>

			<label className="text-xs text-muted block">
				Title
				<input
					className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1.5 text-sm"
					value={title}
					maxLength={80}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>

			{source.params.map((p) => (
				<label key={p.id} className="text-xs text-muted block">
					{p.label}
					{p.required ? " (required)" : ""}
					<input
						className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1.5 text-sm"
						type={p.type === "limit" ? "number" : "text"}
						max={p.max}
						placeholder={p.default !== undefined ? String(p.default) : undefined}
						value={params[p.id] ?? ""}
						onChange={(e) => setParams((prev) => ({ ...prev, [p.id]: e.target.value }))}
					/>
				</label>
			))}

			<div className="flex gap-2">
				<button
					type="button"
					disabled={busy || !title.trim() || missing.length > 0}
					onClick={() =>
						onAdd({
							id: slugifyCardId(title),
							title: title.trim(),
							kind,
							source: source.id,
							// Empty inputs are OMITTED rather than sent as "". Absent takes the server's
							// default; an unparseable value is refused by name. Collapsing the two is
							// exactly how an unparseable limit once meant "drop every record" (#243).
							params: Object.fromEntries(Object.entries(params).filter(([, v]) => v.trim() !== "")),
						})
					}
					className="text-xs px-3 py-1.5 rounded-lg border border-accent bg-accent/10 text-accent font-semibold disabled:opacity-40"
				>
					Add card
				</button>
				<button type="button" onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">
					Cancel
				</button>
				{missing.length > 0 && <span className="text-xs text-muted-soft self-center">Needs {missing.map((m) => m.label).join(", ")}</span>}
			</div>
		</div>
	);
}
