import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import type { AgentOperatorManualResponse, OperatorManualResponse } from "../lib/types";

const MAX = 16_000;

/**
 * The operator manual (#739, #1237): caller-facing notes on how an agent is meant to be driven — never an
 * instruction to the agent. Two layers. A TEMPLATE's manual is inherited by every instance of it, read
 * live (an edit shows on each instance's next read). An INSTANCE's own manual is an addendum after it
 * that wins where the two conflict. On an instance the inherited layer is shown read-only above the
 * editable one, so one screen shows every rule that applies.
 */
export default function OperatorManualCard(props: { instanceId: string } | { agentId: string }) {
	const isTemplate = "agentId" in props;
	const path = isTemplate ? `/v1/agents/${encodeURIComponent(props.agentId)}/operator-manual` : `/v1/instances/${encodeURIComponent(props.instanceId)}/operator-manual`;
	const [inherited, setInherited] = useState("");
	const [instances, setInstances] = useState<number | null>(null);
	const [saved, setSaved] = useState("");
	const [draft, setDraft] = useState("");
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");

	const load = useCallback(async () => {
		setErr("");
		try {
			// Defaulted field by field: a missing one must cost this card its text, never the whole Settings page.
			if (isTemplate) {
				const d = await api<AgentOperatorManualResponse>(path);
				setInstances(typeof d.instances === "number" ? d.instances : null);
				setSaved(d.manual ?? "");
				setDraft(d.manual ?? "");
			} else {
				const d = await api<OperatorManualResponse>(path);
				setInherited(d.inherited ?? "");
				setSaved(d.manual ?? "");
				setDraft(d.manual ?? "");
			}
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [path, isTemplate]);
	useEffect(() => { void load(); }, [load]);

	const save = async () => {
		setBusy(true); setNote("");
		try {
			await api(path, { method: "PUT", body: JSON.stringify({ manual: draft }) });
			setSaved(draft);
			setNote("Saved.");
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		} finally { setBusy(false); }
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid={isTemplate ? "template-operator-manual" : "operator-manual"} aria-labelledby="operator-manual-heading">
			<h2 id="operator-manual-heading" className="font-semibold">{isTemplate ? "Operator manual — inherited by every instance" : "Operator manual"}</h2>
			<p className="text-xs text-muted-soft mt-1 mb-2">
				{isTemplate
					? `Operating standards for whoever drives this agent (checkout layout, delivery rules…). Every instance${instances !== null ? ` — ${instances} now —` : ""} shows it on its next read, with no resync. Notes for the driver, not instructions to the agent.`
					: "Notes for whoever drives this instance — not instructions to the agent. It sees them as data when it reads its manual."}
			</p>
			{err ? (
				<LoadFailed what="the operator manual" detail={err} onRetry={load} testId="operator-manual-load-failed" />
			) : (
				<>
					{!isTemplate && inherited && (
						<div className="mb-3" data-testid="operator-manual-inherited">
							<div className="text-2xs font-bold uppercase tracking-wide text-muted-soft mb-1">Inherited from template</div>
							<pre className="text-xs whitespace-pre-wrap break-words bg-paper border border-line rounded p-2 overflow-x-auto">{inherited}</pre>
						</div>
					)}
					{!isTemplate && inherited && <div className="text-2xs font-bold uppercase tracking-wide text-muted-soft mb-1">This instance — an addendum that wins where they conflict</div>}
					<textarea
						aria-label={isTemplate ? "Template operator manual" : "This instance's operator manual"}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						rows={6}
						maxLength={MAX}
						className="w-full min-w-0 rounded border border-line bg-paper px-2 py-1 text-sm font-mono"
					/>
					<div className="mt-2 flex items-center gap-2 flex-wrap">
						<Button onClick={() => void save()} disabled={busy || draft === saved}>Save</Button>
						<span className="text-2xs text-muted-soft">{draft.length} / {MAX}</span>
						{note && <span className="text-xs" role="status">{note}</span>}
					</div>
				</>
			)}
		</Card>
	);
}
