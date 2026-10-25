import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
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

/** The controller is configured separately from both the advisory Brain and the CLI engine. */
export default function PilotModelCard({ instanceId }: { instanceId: string }) {
	const [pilot, setPilot] = useState<PilotModelView | null>(null);
	const [error, setError] = useState("");
	const load = useCallback(async () => {
		setError(""); setPilot(null);
		try {
			const d = await api<PilotModelResponse>(`/v1/instances/${instanceId}/po-triage/reports?limit=1`);
			if (!validPilot(d?.pilot)) throw new Error("The API did not return a supported Pilot policy. Its version may not support this setting yet. Retry after the API is updated.");
			setPilot(d.pilot);
		} catch (e) { setError(e instanceof Error ? e.message : "Could not load the Pilot model."); }
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	return (
		<Card className="mb-3 sm:mb-4" data-testid="pilot-model-card">
			<h3 className="text-base font-bold mb-1">Pilot — controls the coding session</h3>
			<p className="text-xs text-muted mb-3">The Pilot reads the terminal and directs the coding CLI. The Brain above advises and orchestrates; the coding engine below edits, tests and deploys on your machine.</p>
			<p className="text-xs text-muted mb-3">Haiku is not used for coding. Ticket pickup and queueing use rules, with no model calls or model cost.</p>
			{pilot ? <p className="text-sm"><span className="text-muted">Pilot model: </span><output aria-label="Pilot model">{pilot.options[0].label}</output> (<code>{pilot.model}</code>)</p>
				: !error && <p className="text-xs text-muted">Loading Pilot model…</p>}
			{pilot && <p className="text-xs text-muted mt-2">Uses Anthropic when configured, otherwise the inherited Cloudflare route. Provider token charges are separate from your coding CLI subscription. Your advisory Brain and coding CLI model remain independently configured.</p>}
			{error && <LoadFailed compact what="the Pilot model" detail={error} onRetry={() => void load()} />}
		</Card>
	);
}
