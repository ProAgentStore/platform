import { useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useModalLock } from "@proagentstore/sdk/hooks";
import Button from "./Button";
import Card from "./Card";
import type { InstanceModelState } from "../lib/types";
import { activeBrainLabel } from "../../../../workers/api/src/lib/brain-models";
import { BRAIN_CARD_SCOPE, BRAIN_CARD_TITLE, BRAIN_SURFACES, type BrainOption, brainConfirmation, brainOptions, type KeysStatusResponse, type StoredBrainKeys, storedBrainKeys } from "../lib/brainChoice";

/** The confirmation before a Brain model is saved (#1043): provider, model, cost and who is billed. */
export function BrainConfirmDialog({ option, busy, onConfirm, onCancel }: { option: BrainOption; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
	const c = brainConfirmation(option);
	const wrapRef = useRef<HTMLDivElement>(null);
	useModalLock(wrapRef);
	return (
		<div ref={wrapRef} className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
			<Card role="dialog" aria-modal="true" aria-labelledby="brain-confirm-title" data-testid="brain-confirm" className="w-full max-w-lg">
				<h3 id="brain-confirm-title" className="text-base font-bold mb-2">Use {c.model} as this coder's Brain?</h3>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm mb-3">
					<dt className="text-muted">Provider</dt>
					<dd data-testid="brain-confirm-provider">{c.provider}</dd>
					<dt className="text-muted">Model</dt>
					<dd data-testid="brain-confirm-model">{c.model}</dd>
					<dt className="text-muted">Cost</dt>
					<dd data-testid="brain-confirm-cost">{c.costNote}</dd>
				</dl>
				<p className="text-sm text-warning mb-2" data-testid="brain-confirm-billing">{c.billingWarning}</p>
				<p className="text-xs text-muted mb-3">{BRAIN_SURFACES}</p>
				<div className="flex gap-2 justify-end">
					<Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
					<Button size="sm" variant="primary" onClick={onConfirm} disabled={busy} data-testid="brain-confirm-save">Use this Brain</Button>
				</div>
			</Card>
		</div>
	);
}

/**
 * The picker: every option with its provider and cost; one whose prerequisite is missing is disabled and says why.
 *
 * The select is `w-full max-w-full min-w-0` at EVERY width (#1284). A native select sizes itself to its longest option, and these
 * labels carry provider, cost and the missing-credential note (~850px), so a `sm:w-auto` here let the control outgrow the card from 640px
 * up while the Settings tab's `overflow-x-hidden` clipped its edge and arrow. The closed control now truncates to the card; the full text
 * of every option is still in the open list, and the prerequisites are spelled out below it.
 */
export function BrainModelPicker({ options, value, busy, onPick }: { options: BrainOption[]; value: string; busy?: boolean; onPick: (option: BrainOption) => void }) {
	return (
		<>
			<select
				id="inst-brain-model"
				aria-label="Brain model"
				value={value}
				disabled={busy}
				onChange={(e) => {
					const option = options.find((o) => o.id === e.target.value);
					if (option) onPick(option);
				}}
				className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full max-w-full min-w-0"
			>
				{!options.some((o) => o.id === value) && <option value={value}>{value || "(not set — Claude Sonnet 4.6 by default)"}</option>}
				{options.map((o) => (
					<option key={o.id} value={o.id} disabled={!o.available}>
						{o.label} · {o.providerLabel} — {o.costNote}{o.available ? "" : " (needs Cloudflare credentials)"}
					</option>
				))}
			</select>
			<ul className="text-xs text-muted mt-2" data-testid="brain-prerequisites">
				{options.filter((o) => o.prerequisite).map((o) => (
					<li key={o.id}>{o.label}: {o.prerequisite}</li>
				))}
			</ul>
		</>
	);
}

/**
 * Which model runs this coder's Brain — advisory and orchestration only (#852, #1043).
 *
 * The save is checked by the API too: a model that cannot call tools, or a Cloudflare pick without
 * working Cloudflare credentials, is refused with a sentence saying what to do, shown here as it is.
 */
export default function BrainModelCard({ instanceId }: { instanceId: string }) {
	const [state, setState] = useState<InstanceModelState | null>(null);
	const [keys, setKeys] = useState<StoredBrainKeys>({ anthropic: null, cloudflare: null });
	const [pending, setPending] = useState<BrainOption | null>(null);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		api<InstanceModelState>(`/v1/instances/${instanceId}/state`)
			.then(setState)
			.catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
		api<KeysStatusResponse>("/v1/keys/status")
			.then((d) => setKeys(storedBrainKeys(d)))
			.catch(() => {}); // unknown stays null: the choice is offered and the API decides
	}, [instanceId]);

	const confirm = async () => {
		if (!pending) return;
		setBusy(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/state`, { method: "PUT", body: JSON.stringify({ model: pending.id }) });
			setState((s) => ({ ...(s ?? {}), model: pending.id, modelChosen: true }) as InstanceModelState);
			setMsg("Saved — the Brain's next turn uses it.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setPending(null);
		setBusy(false);
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid="brain-model-card">
			<h3 className="text-base font-bold mb-1">{BRAIN_CARD_TITLE}</h3>
			<p className="text-sm font-semibold mb-1">{BRAIN_CARD_SCOPE}</p>
			<p className="text-xs text-muted mb-3">{BRAIN_SURFACES}</p>
			{state && (
				<>
					<p className="text-xs mb-2" data-testid="brain-active">{activeBrainLabel(state)}</p>
					<BrainModelPicker options={brainOptions(keys)} value={state.model ?? ""} busy={busy} onPick={setPending} />
				</>
			)}
			{msg && <p className="text-xs text-muted mt-2" id="inst-brain-model-msg">{msg}</p>}
			{pending && <BrainConfirmDialog option={pending} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPending(null)} />}
		</Card>
	);
}
