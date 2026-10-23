import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useModalLock } from "@proagentstore/sdk/hooks";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import { DEFAULT_PILOT_MODEL, PILOT_MODEL_OPTIONS, type PilotModelResponse } from "../../../../workers/api/src/lib/pilot-model-contract";

export type PilotModelView = PilotModelResponse["pilot"];

function validPilot(value: unknown): value is PilotModelView {
	if (!value || typeof value !== "object") return false;
	const p = value as Partial<PilotModelView>;
	return p.fallbackModel === DEFAULT_PILOT_MODEL && Array.isArray(p.options)
		&& p.options.length === PILOT_MODEL_OPTIONS.length
		&& PILOT_MODEL_OPTIONS.every((known) => p.options?.some((o) => o?.id === known.id && typeof o.label === "string" && typeof o.hint === "string"))
		&& PILOT_MODEL_OPTIONS.some((known) => known.id === p.model);
}

export function PilotConfirmDialog({ option, fallbackModel, busy, onConfirm, onCancel }: {
	option: PilotModelView["options"][number];
	fallbackModel: string;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const canary = option.id === "claude-haiku-5-5";
	const ref = useRef<HTMLDivElement>(null);
	useModalLock(ref);
	return (
		<div ref={ref} className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
			<Card role="dialog" aria-modal="true" aria-labelledby="pilot-confirm-title" className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
				<h3 id="pilot-confirm-title" className="text-base font-bold mb-2">Use {option.label} as this coder's Pilot?</h3>
				<p className="text-sm mb-2">{option.hint}</p>
				<p className="text-sm text-warning mb-2">{canary ? "Haiku 5.5 and its Sonnet fallback require your own Anthropic API key. Billed per token, separately from your coding CLI subscription." : "Uses your Anthropic API key when configured; otherwise keeps the inherited Cloudflare route. Provider token charges are separate from your coding CLI subscription."}</p>
				<p className="text-xs text-muted mb-3">The Pilot controls the coding session. The canary's fixed fallback is <code>{fallbackModel}</code>. This choice leaves the advisory Brain and coding CLI model unchanged. Haiku 5.5 is an experimental canary, not a promise of equivalent results.</p>
				<div className="flex flex-wrap gap-2 justify-end">
					<Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
					<Button size="sm" variant="primary" disabled={busy} onClick={onConfirm}>Use this Pilot</Button>
				</div>
			</Card>
		</div>
	);
}

/** The controller is configured separately from both the advisory Brain and the CLI engine. */
export default function PilotModelCard({ instanceId }: { instanceId: string }) {
	const [pilot, setPilot] = useState<PilotModelView | null>(null);
	const [pending, setPending] = useState<PilotModelView["options"][number] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saveError, setSaveError] = useState("");
	const [unverified, setUnverified] = useState(false);
	const [message, setMessage] = useState("");
	const load = useCallback(async () => {
		setError(""); setMessage("");
		try {
			const d = await api<PilotModelResponse>(`/v1/instances/${instanceId}/po-triage/reports?limit=1`);
			if (!validPilot(d?.pilot)) throw new Error("The API did not return a supported Pilot policy. Its version may not support this setting yet. Retry after the API is updated.");
			setPilot(d.pilot); setUnverified(false); setSaveError("");
		} catch (e) { setError(e instanceof Error ? e.message : "Could not load the Pilot model."); }
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	const confirm = async () => {
		if (!pending) return;
		setBusy(true); setSaveError(""); setMessage("");
		try {
			const d = await api<PilotModelResponse>(`/v1/instances/${instanceId}/coder-brain`, { method: "PUT", body: JSON.stringify({ pilotModel: pending.id }) });
			if (!validPilot(d?.pilot) || d.pilot.model !== pending.id) throw new Error("The API did not confirm the requested Pilot policy; its version may not support this setting yet.");
			setPilot(d.pilot);
			setMessage("Saved — Pilot policy updated.");
		} catch (e) {
			setUnverified(true);
			setSaveError(`${e instanceof Error ? e.message : "Could not verify the save."} Your request may have been applied. Reload the policy to check before trying again.`);
		}
		finally { setBusy(false); setPending(null); }
	};
	return (
		<Card className="mb-3 sm:mb-4" data-testid="pilot-model-card">
			<h3 className="text-base font-bold mb-1">Pilot — controls the coding session</h3>
			<p className="text-xs text-muted mb-3">The Pilot reads the terminal and directs the coding CLI. The Brain above advises and orchestrates; the coding engine below edits, tests and deploys on your machine.</p>
			{pilot ? <>
				<label htmlFor="inst-pilot-model" className="block text-xs text-muted mb-1">Pilot model</label>
				<select id="inst-pilot-model" value={pilot.model} disabled={busy || unverified} className="w-full max-w-full min-w-0 text-sm" onChange={(e) => {
					const option = pilot.options.find((o) => o.id === e.target.value);
					if (option && option.id !== pilot.model) setPending(option);
				}}>
					{pilot.options.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.hint}</option>)}
				</select>
				<p className="text-xs text-muted mt-2">Sonnet is the default: it uses Anthropic when configured, otherwise keeps the inherited Cloudflare route. Haiku 5.5 is an experimental canary; it and its fixed fallback, <code>{pilot.fallbackModel}</code>, require your Anthropic API key. Provider token charges are separate from your coding CLI subscription.</p>
			</> : !error && <p className="text-xs text-muted">Loading Pilot model…</p>}
			{error && <LoadFailed compact what="the Pilot model" detail={error} onRetry={() => void load()} />}
			{saveError && <p className="text-xs text-danger mt-2" role="alert">Couldn't verify the Pilot model save: {saveError}</p>}
			{unverified && <div className="mt-2 text-xs text-muted">Last confirmed policy shown. <Button size="sm" onClick={() => void load()}>Reload Pilot policy</Button></div>}
			{message && <p className="text-xs text-muted mt-2" role="status">{message}</p>}
			{pending && pilot && <PilotConfirmDialog option={pending} fallbackModel={pilot.fallbackModel} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPending(null)} />}
		</Card>
	);
}
