import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import type { AccountOperatorManualResponse, AgentOperatorManualResponse, OperatorManualResponse } from "../lib/types";

const MAX = 16_000;

/**
 * What an instance inherits, read-only, in precedence order: your ACCOUNT's manual (#1238), then the agent TEMPLATE's (#1237).
 * Empty layers are left out; nothing at all renders nothing.
 */
export function InheritedLayers({ account, inherited }: { account: string; inherited: string }) {
	if (!account && !inherited) return null;
	const layer = (title: string, text: string, testId: string) => (
		<div className="mb-3" data-testid={testId}>
			<div className="text-2xs font-bold uppercase tracking-wide text-muted-soft mb-1">{title}</div>
			<pre className="text-xs whitespace-pre-wrap break-words bg-paper border border-line rounded p-2 overflow-x-auto">{text}</pre>
		</div>
	);
	return (
		<>
			{account && layer("Inherited from your account", account, "operator-manual-account")}
			{inherited && layer("Inherited from template", inherited, "operator-manual-inherited")}
			<div className="text-2xs font-bold uppercase tracking-wide text-muted-soft mb-1">This instance — an addendum that wins where they conflict</div>
		</>
	);
}

/**
 * The operator manual (#739, #1237, #1238): caller-facing notes on how an agent is meant to be driven — never an
 * instruction to the agent. Three layers, each read live (an edit shows on every affected instance's next read):
 * your ACCOUNT's manual applies to every template you run; a TEMPLATE's is inherited by every instance of it; an
 * INSTANCE's own is an addendum after both that wins where they conflict. On an instance the inherited layers are
 * shown read-only above the editable one, so one screen shows every rule that applies.
 */
export default function OperatorManualCard(props: { instanceId: string } | { agentId: string } | { account: true }) {
	const isAccount = "account" in props;
	const isTemplate = "agentId" in props;
	const path = isAccount ? "/v1/preferences/operator-manual" : isTemplate ? `/v1/agents/${encodeURIComponent(props.agentId)}/operator-manual` : `/v1/instances/${encodeURIComponent(props.instanceId)}/operator-manual`;
	const [account, setAccount] = useState("");
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
			if (isAccount || isTemplate) {
				const d = await api<AgentOperatorManualResponse | AccountOperatorManualResponse>(path);
				setInstances(typeof d.instances === "number" ? d.instances : null);
				setSaved(d.manual ?? "");
				setDraft(d.manual ?? "");
			} else {
				const d = await api<OperatorManualResponse>(path);
				setAccount(d.account ?? "");
				setInherited(d.inherited ?? "");
				setSaved(d.manual ?? "");
				setDraft(d.manual ?? "");
			}
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [path, isAccount, isTemplate]);
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
		<Card className="mb-3 sm:mb-4" data-testid={isAccount ? "account-operator-manual" : isTemplate ? "template-operator-manual" : "operator-manual"} aria-labelledby={isAccount ? "account-operator-manual-heading" : "operator-manual-heading"}>
			<h2 id={isAccount ? "account-operator-manual-heading" : "operator-manual-heading"} className="font-semibold">{isAccount ? "Operator manual — applies to every agent you run" : isTemplate ? "Operator manual — inherited by every instance" : "Operator manual"}</h2>
			<p className="text-xs text-muted-soft mt-1 mb-2">
				{isAccount
					? `Operating standards that apply to every template you run (your machines, main-only delivery, the checkout layout…). Every instance${instances !== null ? ` — ${instances} now —` : ""} shows it first, ahead of its template's manual and its own, on its next read, with no resync. Notes for the driver, not instructions to the agent.`
					: isTemplate
					? `Operating standards for whoever drives this agent (checkout layout, delivery rules…). Every instance${instances !== null ? ` — ${instances} now —` : ""} shows it on its next read, with no resync. Notes for the driver, not instructions to the agent.`
					: "Notes for whoever drives this instance — not instructions to the agent. It sees them as data when it reads its manual."}
			</p>
			{err ? (
				<LoadFailed what="the operator manual" detail={err} onRetry={load} testId="operator-manual-load-failed" />
			) : (
				<>
					{!isAccount && !isTemplate && <InheritedLayers account={account} inherited={inherited} />}
					<textarea
						aria-label={isAccount ? "Account operator manual" : isTemplate ? "Template operator manual" : "This instance's operator manual"}
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
