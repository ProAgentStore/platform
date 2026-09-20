import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { CLI_DEFAULT, OTHER_MODEL, choiceBody, chosenEngine, modelOptions, observedLine, type EngineChoice } from "../lib/engineChoice";

/**
 * Which coding CLI this agent opens sessions with, and which model it runs (#792).
 *
 * A view of the state the Coding tab's CLI engines panel owns, not a setting of its own — see
 * `lib/engineChoice.ts`. The panel stays the place to edit a command; this is the place to CHOOSE.
 */
export default function CodingEngineCard({ instanceId }: { instanceId: string }) {
	const [choice, setChoice] = useState<EngineChoice | null>(null);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	// Non-null while "Another model…" is open: the text typed so far.
	const [other, setOther] = useState<string | null>(null);

	useEffect(() => {
		api<EngineChoice>(`/v1/instances/${instanceId}/coding/engine-choice`)
			.then(setChoice)
			.catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
	}, [instanceId]);

	const save = async (engineId: string, model?: string) => {
		setBusy(true);
		setMsg("");
		try {
			setChoice(await api<EngineChoice>(`/v1/instances/${instanceId}/coding/engine-choice`, { method: "PUT", body: JSON.stringify(choiceBody(engineId, model)) }));
			setOther(null);
			setMsg("Saved.");
		} catch (e) {
			// The server's refusals say what to do instead, so they are shown as they are.
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	const engine = choice ? chosenEngine(choice) : undefined;

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Coding engine</h3>
			<p className="text-sm text-muted mb-3">Which coding CLI this agent runs on your machine, and which model it uses.</p>
			{choice && engine && (
				<div className="space-y-3">
					<div>
						<label htmlFor="inst-engine" className="text-xs text-muted block mb-1">Engine</label>
						<select
							id="inst-engine"
							value={engine.id}
							disabled={busy}
							onChange={(e) => save(e.target.value)}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
						>
							{choice.engines.map((e) => (
								<option key={e.id} value={e.id}>{e.label}</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor="inst-engine-model" className="text-xs text-muted block mb-1">Model</label>
						{engine.modelSelectable ? (
							<select
								id="inst-engine-model"
								value={other !== null ? OTHER_MODEL : (engine.model ?? CLI_DEFAULT)}
								disabled={busy}
								onChange={(e) => (e.target.value === OTHER_MODEL ? setOther("") : save(engine.id, e.target.value))}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
							>
								{modelOptions(engine).map((o) => (
									<option key={o.value} value={o.value}>{o.label}</option>
								))}
							</select>
						) : (
							<p className="text-sm text-muted" id="inst-engine-model">This engine's model is part of its command — edit it under CLI engines on the Coding tab.</p>
						)}
						{other !== null && (
							<div className="flex gap-2 mt-2">
								<input
									aria-label="Model id"
									value={other}
									onChange={(e) => setOther(e.target.value)}
									placeholder="The id this CLI accepts"
									className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 min-w-0 flex-1 sm:flex-none sm:w-64"
								/>
								<Button size="sm" disabled={busy || !other.trim()} onClick={() => save(engine.id, other)}>Use</Button>
							</div>
						)}
					</div>
					<p className="text-xs text-muted break-all" id="inst-engine-command">Launches: <code>{engine.command}</code></p>
					{observedLine(choice) && <p className="text-xs text-muted" id="inst-engine-observed">{observedLine(choice)}</p>}
					<p className="text-xs text-muted">{choice.appliesTo}</p>
				</div>
			)}
			{msg && <p className="text-xs text-muted mt-2" id="inst-engine-msg">{msg}</p>}
		</Card>
	);
}
