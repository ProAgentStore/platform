/**
 * The screenshot replay player (#1063) — one component for every browser run.
 *
 * Extracted from RunDetail so a Scout's research run and an Application Runner's fill play back with the
 * same controls as a workflow task: play/pause, previous/next, a named scrubber, a counter, and a caption
 * from the frame's metadata. Frames are fetched with the owner's token (an <img> cannot send a Bearer
 * header) and held as object URLs, revoked on unmount.
 */
import { useEffect, useRef, useState } from "react";
import { API, api, getToken } from "@proagentstore/sdk/client";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import Card from "./Card";
import { type BrowserArtifactListResponse, type BrowserArtifactView, type ReplayFrame, type ReplaySubjectKind } from "../lib/runReplay";

/** A subject's stored screenshots; re-read whenever `refreshKey` changes (e.g. the run's event count). */
export function useBrowserArtifacts(instanceId: string, subjectKind: ReplaySubjectKind, subjectId: string | null | undefined, refreshKey: unknown = 0): BrowserArtifactView[] {
	const [artifacts, setArtifacts] = useState<BrowserArtifactView[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` is the re-read trigger (the run's event count), not a value the effect reads.
	useEffect(() => {
		if (!subjectId) return;
		let cancelled = false;
		// Written out in full: the MCP-parity check reads a console path as a literal.
		api<BrowserArtifactListResponse>(`/v1/instances/${instanceId}/browser-artifacts?subject_kind=${subjectKind}&subject_id=${encodeURIComponent(subjectId)}`)
			.then((r) => {
				if (!cancelled) setArtifacts(r.artifacts ?? []);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [instanceId, subjectKind, subjectId, refreshKey]);
	return artifacts;
}

const fmtStamp = (at?: string) => (at ? new Date(at).toLocaleTimeString() : "");

export default function RunReplay({ frames, emptyText }: { frames: readonly ReplayFrame[]; emptyText: string }) {
	const [urls, setUrls] = useState<Record<string, string>>({});
	const [idx, setIdx] = useState(0);
	const [playing, setPlaying] = useState(false);
	const urlsRef = useRef<Record<string, string>>({});

	// Fetch each frame with auth; browser image elements cannot send a Bearer header.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const tok = getToken();
			for (const f of frames) {
				if (urlsRef.current[f.key]) continue;
				try {
					const res = await fetch(`${API}${f.src}`, { headers: { Authorization: `Bearer ${tok}` } });
					if (!res.ok) continue;
					const blob = await res.blob();
					if (cancelled) return;
					urlsRef.current[f.key] = URL.createObjectURL(blob);
					setUrls({ ...urlsRef.current });
				} catch {
					/* a missing frame stays "Loading…" — the rest still play */
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [frames]);

	useEffect(() => () => Object.values(urlsRef.current).forEach(URL.revokeObjectURL), []);
	useEffect(() => {
		if (idx > frames.length - 1) setIdx(Math.max(0, frames.length - 1));
	}, [frames.length, idx]);
	useEffect(() => {
		if (!playing || frames.length === 0) return;
		const t = setInterval(
			() =>
				setIdx((i) => {
					if (i < frames.length - 1) return i + 1;
					setPlaying(false);
					return i;
				}),
			1200,
		);
		return () => clearInterval(t);
	}, [playing, frames.length]);

	if (!frames.length) return <div className="bg-panel border border-line rounded-xl p-4 mb-5 text-sm text-muted-soft" data-testid="replay-empty">{emptyText}</div>;
	const cur = frames[Math.min(idx, frames.length - 1)];
	return (
		<Card className="mb-5" data-testid="run-replay">
			<div className="flex items-center gap-3 mb-3">
				<button type="button" onClick={() => setPlaying((p) => !p)} className="w-9 h-9 flex items-center justify-center rounded-lg bg-accent text-white shrink-0" aria-label={playing ? "Pause" : "Play"}>
					{playing ? <Pause size={16} /> : <Play size={16} />}
				</button>
				<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)); }} disabled={idx <= 0} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Previous"><ChevronLeft size={16} /></button>
				<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.min(frames.length - 1, i + 1)); }} disabled={idx >= frames.length - 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Next"><ChevronRight size={16} /></button>
				<input type="range" min={0} max={Math.max(0, frames.length - 1)} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="flex-1 min-w-0 accent-accent" aria-label="Step" aria-valuetext={`Step ${idx + 1} of ${frames.length}`} />
				<span className="text-xs text-muted-soft font-mono shrink-0">{idx + 1}/{frames.length}</span>
			</div>
			<div className="rounded-lg overflow-hidden border border-line bg-paper flex items-center justify-center min-h-[240px]">
				{urls[cur.key] ? <img src={urls[cur.key]} alt={`Step ${cur.seq}`} width={1280} height={720} className="w-full max-h-[520px] object-contain" /> : <span className="text-sm text-muted-soft py-16">Loading screenshot…</span>}
			</div>
			<div className="flex items-baseline justify-between gap-3 mt-2.5">
				<div className="text-sm text-ink" data-testid="replay-caption">
					<span className="font-semibold">Step {cur.seq}:</span> {cur.caption}
				</div>
				<span className="text-xs text-muted-soft font-mono shrink-0">{fmtStamp(cur.at)}</span>
			</div>
		</Card>
	);
}
