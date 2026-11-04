/**
 * The screenshot replay player (#1063) — one component for every browser run.
 *
 * Extracted from RunDetail so a Scout's research run and an Application Runner's fill play back with the
 * same controls as a workflow task: play/pause, previous/next, a named scrubber, a counter, and a caption
 * from the frame's metadata. Frames are fetched with the owner's token (an <img> cannot send a Bearer
 * header) and held as object URLs, revoked on unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { API, api, getToken } from "@proagentstore/sdk/client";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import Card from "./Card";
import { type ReplayFrame, type ReplaySubjectKind } from "../lib/runReplay";
import { emptyReplayHistory, loadReplayHistory, replayHistorySummary, type BrowserArtifactPageResponse, type ReplayHistoryState } from "../lib/replayHistory";

/**
 * A subject's stored screenshots, and whether the run started with screenshots OFF (#1064) — then it has
 * none by design; re-read whenever `refreshKey` changes (e.g. the run's event count).
 */
export function useBrowserArtifacts(instanceId: string, subjectKind: ReplaySubjectKind, subjectId: string | null | undefined, refreshKey: unknown = 0) {
	const scope = `${instanceId}:${subjectKind}:${subjectId ?? ""}`;
	const [state, setState] = useState({ scope, history: emptyReplayHistory() });
	const [historyLoading, setHistoryLoading] = useState(false);
	const retained = useRef(state);
	const generation = useRef(0);
	const pending = useRef(false);
	useEffect(() => {
		generation.current++;
		pending.current = false;
		retained.current = { scope, history: emptyReplayHistory() };
		setState(retained.current);
		setHistoryLoading(false);
		return () => { generation.current++; };
	}, [scope]);
	const loadHistory = useCallback(async () => {
		if (!subjectId || pending.current) return;
		const currentGeneration = generation.current;
		pending.current = true;
		setHistoryLoading(true);
		try {
			const history = await loadReplayHistory(retained.current.history, { kind: subjectKind, id: subjectId }, (after, limit) =>
				api<BrowserArtifactPageResponse>(`/v1/instances/${encodeURIComponent(instanceId)}/browser-artifacts?subject_kind=${subjectKind}&subject_id=${encodeURIComponent(subjectId)}&limit=${limit}&cursor=${after}`),
			);
			if (generation.current === currentGeneration) { retained.current = { scope, history }; setState(retained.current); }
		} finally {
			if (generation.current === currentGeneration) { pending.current = false; setHistoryLoading(false); }
		}
	}, [instanceId, subjectKind, subjectId, scope]);
	// Refresh triggers continue the existing bounded traversal; an in-flight batch is never
	// cancelled by a five-second poll, so slow connections can still make forward progress.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the caller's explicit re-read trigger.
	useEffect(() => { void loadHistory(); }, [loadHistory, refreshKey]);
	const history = state.scope === scope ? state.history : emptyReplayHistory();
	return { artifacts: history.artifacts, screenshotsOff: history.screenshotsOff, history, historyLoading, loadHistory };
}

const fmtStamp = (at?: string) => (at ? new Date(at).toLocaleTimeString() : "");

export default function RunReplay({ frames, emptyText, history, historyLoading = false, onLoadMore }: { frames: readonly ReplayFrame[]; emptyText: string; history?: ReplayHistoryState; historyLoading?: boolean; onLoadMore?: () => void }) {
	const [urls, setUrls] = useState<Record<string, string>>({});
	const [failed, setFailed] = useState<Record<string, boolean>>({});
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const idx = Math.max(0, frames.findIndex((frame) => frame.key === selectedKey));
	const select = (index: number) => setSelectedKey(frames[Math.max(0, Math.min(frames.length - 1, index))]?.key ?? null);
	const [playing, setPlaying] = useState(false);
	const urlsRef = useRef<Record<string, string>>({});
	const wantedImages = [frames[idx], frames[idx + 1], frames[idx - 1]].filter((frame): frame is ReplayFrame => !!frame);
	const imageWindow = JSON.stringify(wantedImages.map((frame) => [frame.key, frame.src]));
	const imageWindowRef = useRef(wantedImages);
	imageWindowRef.current = wantedImages;

	// Load the selected image first and only its neighbors: a late frame must not wait
	// behind hundreds of earlier blob requests. Cached images are bounded and revoked.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a changed image identity window cancels blob work, not metadata polling.
	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		(async () => {
			const tok = getToken();
			const wanted = imageWindowRef.current;
			for (const f of wanted) {
				if (urlsRef.current[f.key]) continue;
				try {
					const res = await fetch(`${API}${f.src}`, { headers: { Authorization: `Bearer ${tok}` }, signal: controller.signal });
					if (!res.ok) throw new Error("Screenshot unavailable");
					const blob = await res.blob();
					if (cancelled) return;
					urlsRef.current[f.key] = URL.createObjectURL(blob);
					for (const key of Object.keys(urlsRef.current)) {
						if (Object.keys(urlsRef.current).length <= 20) break;
						if (wanted.some((frame) => frame.key === key)) continue;
						URL.revokeObjectURL(urlsRef.current[key]); delete urlsRef.current[key];
					}
					setFailed((old) => ({ ...old, [f.key]: false }));
					setUrls({ ...urlsRef.current });
				} catch {
					if (cancelled) return;
					setFailed((old) => ({ ...old, [f.key]: true }));
				}
			}
		})();
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [imageWindow]);

	useEffect(() => () => Object.values(urlsRef.current).forEach(URL.revokeObjectURL), []);
	useEffect(() => {
		if (selectedKey && !frames.some((frame) => frame.key === selectedKey)) setSelectedKey(frames[0]?.key ?? null);
	}, [frames, selectedKey]);
	useEffect(() => {
		if (!playing || frames.length === 0) return;
		const timer = setInterval(() => setSelectedKey((current) => {
			const index = Math.max(0, frames.findIndex((frame) => frame.key === current));
			if (index >= frames.length - 1) { setPlaying(false); return current; }
			return frames[index + 1].key;
		}), 1200);
		return () => clearInterval(timer);
	}, [playing, frames]);
	const historyNotice = history && <div className="text-xs text-muted-soft mb-3 break-words [overflow-wrap:anywhere]" data-testid="replay-history-status">
		<p>{replayHistorySummary(history)}</p>
		{history.status !== "complete" && history.status !== "loading" && onLoadMore && <button type="button" disabled={historyLoading} onClick={onLoadMore} className="mt-2 underline text-accent disabled:opacity-50">{history.error ? "Retry screenshot history" : history.hasMore ? "Load more history" : "Refresh screenshot history"}</button>}
	</div>;

	const noFramesText = history?.status === "loading" ? "Loading stored screenshots…" : history?.error ? "Stored screenshots could not be loaded. Retry the history request." : emptyText;
	if (!frames.length) return <div>{historyNotice}<div className="bg-panel border border-line rounded-xl p-4 mb-5 text-sm text-muted-soft" data-testid="replay-empty">{noFramesText}</div></div>;
	const cur = frames[Math.min(idx, frames.length - 1)];
	return (
		<Card className="mb-5" data-testid="run-replay">
			{historyNotice}
			<div className="flex items-center gap-3 mb-3">
				<button type="button" onClick={() => setPlaying((p) => !p)} className="w-9 h-9 flex items-center justify-center rounded-lg bg-accent text-white shrink-0" aria-label={playing ? "Pause" : "Play"}>
					{playing ? <Pause size={16} /> : <Play size={16} />}
				</button>
				<button type="button" onClick={() => { setPlaying(false); select(idx - 1); }} disabled={idx <= 0} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Previous"><ChevronLeft size={16} /></button>
				<button type="button" onClick={() => { setPlaying(false); select(idx + 1); }} disabled={idx >= frames.length - 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Next"><ChevronRight size={16} /></button>
				<input type="range" min={0} max={Math.max(0, frames.length - 1)} value={idx} onChange={(e) => { setPlaying(false); select(Number(e.target.value)); }} className="flex-1 min-w-0 accent-accent" aria-label="Frame" aria-valuetext={`Frame ${idx + 1} of ${frames.length}`} />
				<span className="text-xs text-muted-soft font-mono shrink-0">{idx + 1}/{frames.length}</span>
			</div>
			<div className="rounded-lg overflow-hidden border border-line bg-paper flex items-center justify-center min-h-[240px]">
				{failed[cur.key] ? <span className="text-sm text-muted-soft py-16">Screenshot unavailable for this frame.</span> : urls[cur.key] ? <img key={cur.key} src={urls[cur.key]} alt={`Frame ${cur.seq}: ${cur.caption}`} onError={() => setFailed((old) => ({ ...old, [cur.key]: true }))} width={1280} height={720} className="w-full max-h-[520px] object-contain" /> : <span className="text-sm text-muted-soft py-16">Loading screenshot…</span>}
			</div>
			<div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-3 mt-2.5">
				<div className="min-w-0 flex-1 break-words text-sm text-ink" data-testid="replay-caption">
					<span className="font-semibold">Frame {cur.seq}:</span> {cur.caption}
				</div>
				<span className="text-xs text-muted-soft font-mono shrink-0">{cur.timeKind === "stored" ? "Stored " : "Captured "}{fmtStamp(cur.at)}</span>
			</div>
			<p className="text-xs text-muted-soft mt-1">Screenshots can show the same page between actions.</p>
		</Card>
	);
}
