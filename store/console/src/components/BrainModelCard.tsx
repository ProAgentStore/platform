import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "./Card";
import { BRAIN_MODELS, brainModel } from "../../../../workers/api/src/lib/brain-models";

/**
 * Which model runs this agent's brain — its chat and orchestration (#852).
 *
 * The list and its cost hints are the API's own (`lib/brain-models.ts`), and the save is checked
 * there too: a model that cannot call tools, or a Cloudflare pick with no Cloudflare credentials,
 * is refused with a sentence saying what to do, shown here as it is.
 */
export default function BrainModelCard({ instanceId }: { instanceId: string }) {
	const [model, setModel] = useState<string | null>(null);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		api<{ model?: string }>(`/v1/instances/${instanceId}/state`)
			.then((s) => setModel(s.model ?? ""))
			.catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
	}, [instanceId]);

	const save = async (next: string) => {
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/state`, { method: "PUT", body: JSON.stringify({ model: next }) });
			setModel(next);
			setMsg("Saved — the next turn uses it.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	// A model set before this picker existed is shown as itself rather than silently as another.
	const current = model !== null && !brainModel(model) ? model : null;

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Brain model</h3>
			<p className="text-sm text-muted mb-3">
				The model that runs this agent's chat and orchestration. Every option can call tools; a cheap Cloudflare model is enough for light orchestration — relaying objectives, reading the terminal, reporting progress.
			</p>
			{model !== null && (
				<select
					id="inst-brain-model"
					aria-label="Brain model"
					value={model}
					disabled={busy}
					onChange={(e) => save(e.target.value)}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
				>
					{current !== null && <option value={current}>{current || "(not set)"}</option>}
					{BRAIN_MODELS.map((m) => (
						<option key={m.id} value={m.id}>
							{m.label} — {m.hint}
						</option>
					))}
				</select>
			)}
			{msg && <p className="text-xs text-muted mt-2" id="inst-brain-model-msg">{msg}</p>}
		</Card>
	);
}
