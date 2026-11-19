import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { RemoteFrame } from "./RemoteBrowser";
import Button from "./Button";
import ZoomableImage from "./ZoomableImage";

/** A live endpoint is a separate position, never a stored screenshot or an input capability. */
export default function ApplicationReplayLive({ instanceId, runId, handoff, reconciliation, onTakeOver, onRequestControl }: {
	instanceId: string;
	runId: string | null | undefined;
	handoff: { id: string; runId: string; state: string } | null;
	reconciliation: boolean;
	onTakeOver: () => void;
	onRequestControl?: () => Promise<void>;
}) {
	const active = !!runId && handoff?.runId === runId && handoff.state === "active";
	const base = !active ? null : reconciliation
		? `/v1/instances/${encodeURIComponent(instanceId)}/application-runs/${encodeURIComponent(runId)}/reconciliation/handoff/frame?handoff_id=${encodeURIComponent(handoff.id)}`
		: `/v1/instances/${encodeURIComponent(instanceId)}/application-runs/${encodeURIComponent(runId)}/handoff/frame?handoff_id=${encodeURIComponent(handoff.id)}`;
	const [image, setImage] = useState<{ base: string; frame: RemoteFrame } | null>(null);
	const [error, setError] = useState("");
	const [requesting, setRequesting] = useState(false);
	const [requestError, setRequestError] = useState("");
	const request = async () => {
		setRequesting(true); setRequestError("");
		try { await onRequestControl?.(); } catch (e) { setRequestError(e instanceof Error ? e.message : String(e)); }
		finally { setRequesting(false); }
	};
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		setImage(null); setError("");
		if (!base) return;
		const poll = async () => {
			try {
				const frame = await api<RemoteFrame>(base);
				if (!frame?.frame || frame.frame.length < 30) throw new Error("No current browser frame.");
				if (!cancelled) { setImage({ base, frame }); setError(""); }
			} catch (e) {
				if (!cancelled) { setImage(null); setError(e instanceof Error ? e.message : String(e)); }
			}
			if (!cancelled) timer = setTimeout(poll, 1000);
		};
		void poll();
		return () => { cancelled = true; clearTimeout(timer); };
	}, [base]);
	return <div className="min-w-0" data-testid="application-replay-live">
		<h5 className="font-semibold">Live browser</h5>
		{base ? <>
			{image?.base === base && <div className="mt-2"><ZoomableImage src={image.frame.frame} width={image.frame.width} height={image.frame.height} alt="Current Application Runner browser — read-only preview" overlayExtra={<Button size="lg" variant="primary" disabled={!!error} onClick={onTakeOver}>Take over live browser</Button>} /></div>}
			<p className="text-sm text-muted my-2 break-words">{error ? `Live browser unavailable: ${error}` : image?.base === base ? "Current browser preview. Open the secure control to interact." : "Connecting to this run’s existing browser…"}</p>
			<Button size="lg" variant="primary" disabled={!!error || image?.base !== base} onClick={onTakeOver}>Take over live browser</Button>
		</> : <p role="status" data-testid="replay-live-unavailable" className="text-sm text-muted mt-2 break-words">{handoff && handoff.runId === runId ? "Live takeover is unavailable for this run — this handoff is no longer active." : "Live takeover is unavailable for this run."} An active owner-authorized handoff for this exact browser run is required. Stored screenshots below are history and remain read-only.</p>}
		{!base && onRequestControl && <><p className="text-sm text-muted my-2">Pause the agent and wait for its browser actions to settle before taking control. This does not grant submission permission.</p><Button size="sm" disabled={requesting} onClick={() => void request()}>{requesting ? "Pausing browser…" : "Pause and take control"}</Button></>}
		{requestError && <p role="alert" className="text-sm text-danger mt-2 break-words">{requestError}</p>}
	</div>;
}
