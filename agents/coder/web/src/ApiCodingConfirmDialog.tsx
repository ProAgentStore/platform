import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import Button from "./Button";
import type { PendingApiConfirmation } from "./api-coding";

/**
 * The blocking confirmation before an engine preset may code on a provider API key (#1042). It names,
 * per preset, the provider, the model and where the bill goes, says it is likely more costly and billed
 * separately from the subscription, and does nothing until the owner ticks the acknowledgement.
 */
export default function ApiCodingConfirmDialog({ pending, busy, onCancel, onConfirm }: {
	pending: PendingApiConfirmation[];
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const [acknowledged, setAcknowledged] = useState(false);
	return (
		<div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4">
			<div role="dialog" aria-modal="true" aria-labelledby="api-coding-title" data-testid="api-coding-confirm" className="bg-panel border border-danger rounded-2xl w-full max-w-lg p-4">
				<h3 id="api-coding-title" className="text-base font-bold text-danger flex items-center gap-1.5 mb-2">
					<AlertTriangle size={16} /> Code on a provider API key?
				</h3>
				<p className="text-sm mb-3">
					API-key coding is <b>likely more costly</b> than your subscription CLI and is <b>billed separately</b> from any subscription — every token goes to your own provider account.
				</p>
				<ul className="flex flex-col gap-2 mb-3" data-testid="api-coding-confirm-list">
					{pending.map(({ engine, option, model }) => (
						<li key={engine.id} className="border border-line rounded-lg p-2 text-xs">
							<div className="font-bold">{engine.label || engine.id}</div>
							<div>Provider: <b>{option?.providerLabel ?? "unknown provider"}</b></div>
							<div>Model: <b>{model ?? "the CLI's default model"}</b></div>
							<div>Billed to: <b>your {option?.providerLabel ?? "provider"} API key</b> (Profile → API Keys), per token</div>
							{option?.warning && <p className="text-muted mt-1">{option.warning}</p>}
						</li>
					))}
				</ul>
				<label className="flex gap-2 items-start text-sm mb-3">
					<input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} data-testid="api-coding-acknowledge" />
					<span>I understand this coder will bill every token to my own provider API key, separately from my subscription.</span>
				</label>
				<div className="flex gap-2 justify-end">
					<Button size="md" onClick={onCancel} disabled={busy}>Cancel</Button>
					<Button variant="danger" size="md" onClick={onConfirm} disabled={!acknowledged || busy} data-testid="api-coding-confirm-save">
						Confirm API-key coding
					</Button>
				</div>
			</div>
		</div>
	);
}
