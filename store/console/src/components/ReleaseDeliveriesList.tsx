import { useState } from "react";
import Button from "./Button";
import { DUPLICATE_RISK, headline, RECONCILE_RETRY_PHRASE, type ReconcileChoice, type ReconcileForm, reconcileReady, shortSha, STATE_HINT, STATE_TONE } from "../lib/releaseDeliveries";
import type { ReleaseDelivery } from "../lib/types";

interface Props {
	deliveries: ReleaseDelivery[];
	hasMore: boolean;
	busy: string;
	onRetry: (d: ReleaseDelivery) => void;
	onReconcile: (d: ReleaseDelivery, form: ReconcileForm) => void;
	onMore: () => void;
	/** Opens every reconcile form (tests render the markup without a click). */
	defaultOpen?: boolean;
}

const TONE: Record<string, string> = { ok: "text-ok", wait: "text-muted", warn: "text-warn", bad: "text-danger", muted: "text-muted-soft" };

function Row({ d, busy, onRetry, onReconcile, defaultOpen }: { d: ReleaseDelivery; busy: string; onRetry: Props["onRetry"]; onReconcile: Props["onReconcile"]; defaultOpen: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const [form, setForm] = useState<ReconcileForm>({ choice: "mark_delivered", permalink: "", channelChecked: false, typed: "" });
	const hint = STATE_HINT[d.state];
	const tone = STATE_TONE[d.state];
	return (
		<li className="text-xs bg-paper border border-line rounded-lg px-2.5 py-2" data-testid={`release-delivery-${d.id}`}>
			<div className="flex items-center justify-between gap-2">
				<span className={`font-medium ${TONE[tone]}`}>{headline(d)}</span>
				<span className="text-muted-soft shrink-0">{d.repo} @ {shortSha(d.sha)}</span>
			</div>
			{d.reason && <p className="text-muted mt-1 break-words">{d.holdCode ? <code className="text-2xs mr-1">{d.holdCode}</code> : null}{d.reason}</p>}
			{hint && <p className="text-2xs text-muted-soft mt-1">{hint}</p>}
			<div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-2xs">
				<a className="underline" href={d.links.codingRun}>Coding run</a>
				{d.links.workflowRuns.map((url, i) => (
					<a key={url} className="underline" href={url} target="_blank" rel="noopener noreferrer">Workflow run {i + 1}</a>
				))}
				{d.links.deployJob && <a className="underline" href={d.links.deployJob} target="_blank" rel="noopener noreferrer">Deploy job</a>}
				{d.links.permalink && <a className="underline" href={d.links.permalink} target="_blank" rel="noopener noreferrer">Message</a>}
			</div>
			{d.attempts.length > 0 && (
				<ol className="mt-1 text-2xs text-muted-soft" aria-label="Attempts">
					{d.attempts.map((a) => (
						<li key={a.id}>
							{new Date(a.at).toLocaleString()} · {a.kind.replaceAll("_", " ")} · {a.outcome}
							{a.reason ? ` — ${a.reason}` : ""}
						</li>
					))}
				</ol>
			)}
			{d.actions.retry && (
				<div className="mt-1.5">
					<Button onClick={() => onRetry(d)} disabled={busy === `retry:${d.id}`}>
						{busy === `retry:${d.id}` ? "Retrying…" : "Retry send"}
					</Button>
				</div>
			)}
			{d.actions.reconcile && (
				<div className="mt-1.5">
					{!open ? (
						<button type="button" className="text-muted hover:text-ink underline" onClick={() => setOpen(true)}>
							Settle this send…
						</button>
					) : (
						<fieldset className="border border-line rounded-lg p-2 flex flex-col gap-1.5">
							<legend className="text-2xs text-muted px-1">Settle an uncertain send</legend>
							{(["mark_delivered", "abandon", "retry_after_channel_check"] as ReconcileChoice[]).map((c) => (
								<label key={c} className="flex items-center gap-2">
									<input type="radio" name={`reconcile-${d.id}`} checked={form.choice === c} onChange={() => setForm({ ...form, choice: c })} />
									{c === "mark_delivered" ? "It was delivered — I have the message link" : c === "abandon" ? "Give it up — do not send" : "It never arrived — send it again"}
								</label>
							))}
							{form.choice === "mark_delivered" && <input aria-label="Message link" placeholder="https://… link to the message in the channel" value={form.permalink} onChange={(e) => setForm({ ...form, permalink: e.target.value })} className="bg-paper border border-line rounded-lg px-2 py-1" />}
							{form.choice === "retry_after_channel_check" && (
								<>
									<p className="text-danger" role="alert">{DUPLICATE_RISK}</p>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={form.channelChecked} onChange={(e) => setForm({ ...form, channelChecked: e.target.checked })} />I checked the channel and the note is not there
									</label>
									<input aria-label={`Type: ${RECONCILE_RETRY_PHRASE}`} placeholder={RECONCILE_RETRY_PHRASE} value={form.typed} onChange={(e) => setForm({ ...form, typed: e.target.value })} className="bg-paper border border-line rounded-lg px-2 py-1" />
								</>
							)}
							<div className="flex gap-2">
								<Button onClick={() => onReconcile(d, form)} disabled={!reconcileReady(form) || busy === `reconcile:${d.id}`}>
									Confirm
								</Button>
								<button type="button" className="text-muted hover:text-ink" onClick={() => setOpen(false)}>
									Cancel
								</button>
							</div>
						</fieldset>
					)}
				</div>
			)}
		</li>
	);
}

/** Recent release notes with their state, evidence links and the actions that apply (#1348). Presentational: the panel owns the fetching. */
export default function ReleaseDeliveriesList({ deliveries, hasMore, busy, onRetry, onReconcile, onMore, defaultOpen = false }: Props) {
	if (!deliveries.length) return <p className="text-xs text-muted">No release notes have been queued for this agent yet.</p>;
	return (
		<>
			<ul className="flex flex-col gap-1.5 mb-2">
				{deliveries.map((d) => (
					<Row key={d.id} d={d} busy={busy} onRetry={onRetry} onReconcile={onReconcile} defaultOpen={defaultOpen && d.actions.reconcile} />
				))}
			</ul>
			{hasMore && (
				<button type="button" className="text-2xs text-muted hover:text-ink underline" onClick={onMore}>
					Show older
				</button>
			)}
		</>
	);
}
