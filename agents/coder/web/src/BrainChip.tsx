import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { api } from "@proagentstore/sdk/client";
import { activeBrainLabel } from "../../../../workers/api/src/lib/brain-models";

/**
 * The coder's active Brain model, on the coding screen (#1043) — beside the engine line, never in
 * place of it: the Brain advises and orchestrates on its own key; the engine is the subscription CLI.
 */
export function BrainChipView({ state }: { state: { model?: string; modelChosen?: boolean } | null }) {
	if (!state) return null;
	return (
		<p className="text-2xs text-muted mt-1 flex items-center gap-1" data-testid="brain-chip">
			<Brain size={11} aria-hidden /> {activeBrainLabel(state)}
		</p>
	);
}

export default function BrainChip({ instanceId }: { instanceId: string }) {
	const [state, setState] = useState<{ model?: string; modelChosen?: boolean } | null>(null);
	useEffect(() => {
		let live = true;
		void api<{ model?: string; modelChosen?: boolean }>(`/v1/instances/${instanceId}/state`)
			.then((s) => { if (live) setState(s); })
			.catch(() => {});
		return () => { live = false; };
	}, [instanceId]);
	return <BrainChipView state={state} />;
}
