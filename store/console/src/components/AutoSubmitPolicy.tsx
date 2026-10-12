import Button from "./Button";
import Card from "./Card";
import { AUTO_SUBMIT_ACKNOWLEDGEMENT, AUTO_SUBMIT_DANGER, AUTO_SUBMIT_WARNING, type AutoSubmitAllowance, type AutoSubmitRules, buildPolicySummary } from "../lib/autoSubmitPolicy";

/**
 * The presentational half of standing auto-submit (#1039) — props only, so each piece is rendered and
 * tested as it is. The Submission policy card (`tabs/ApplicationsTab.tsx`) owns the state and requests.
 */

/** The default, said out loud: nothing is submitted without the owner's review. */
export function ManualReviewBadge() {
	return (
		<span data-testid="manual-review-badge" className="inline-block text-xs font-semibold px-2 py-0.5 rounded border border-success text-success">
			Manual review (default)
		</span>
	);
}

/** Every rule an application must match to be submitted without review, and today's allowance. */
export function PolicySummary({ rules, allowance }: { rules: AutoSubmitRules; allowance?: AutoSubmitAllowance | null }) {
	return (
		<dl data-testid="auto-submit-policy-summary" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
			{buildPolicySummary(rules, allowance).map((row) => (
				<div key={row.label} className="contents">
					<dt className="text-muted-soft">{row.label}</dt>
					<dd className="text-ink">{row.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Shown for as long as auto-submit is on, with the one-click way out. */
export function AutoSubmitDangerBanner({ rules, allowance, onDisable, busy }: { rules: AutoSubmitRules; allowance?: AutoSubmitAllowance | null; onDisable: () => void; busy?: boolean }) {
	return (
		<div role="alert" data-testid="auto-submit-danger" className="border border-danger rounded-lg p-3 mb-3">
			<div className="flex flex-wrap gap-2 items-center justify-between mb-2">
				<span className="text-sm font-bold text-danger">⚠ {AUTO_SUBMIT_DANGER}</span>
				<Button size="sm" variant="danger" onClick={onDisable} disabled={busy} data-testid="auto-submit-disable">
					Disable now
				</Button>
			</div>
			<PolicySummary rules={rules} allowance={allowance} />
		</div>
	);
}

/**
 * The confirmation before auto-submit is enabled: the warning, the exact rules that will apply, and an
 * acknowledgement the owner must tick before "Confirm & Enable" does anything.
 */
export function AutoSubmitConfirmDialog({
	rules,
	allowance,
	acknowledged,
	onAcknowledge,
	onConfirm,
	onCancel,
	busy,
	error,
}: {
	rules: AutoSubmitRules;
	allowance?: AutoSubmitAllowance | null;
	acknowledged: boolean;
	onAcknowledge: (value: boolean) => void;
	onConfirm: () => void;
	onCancel: () => void;
	busy?: boolean;
	error?: string;
}) {
	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
			<Card role="dialog" aria-modal="true" aria-labelledby="auto-submit-confirm-title" data-testid="auto-submit-confirm" className="w-full max-w-lg">
				<h3 id="auto-submit-confirm-title" className="text-base font-bold text-danger mb-2">
					Enable auto-submit?
				</h3>
				<p className="text-sm text-ink mb-3" data-testid="auto-submit-warning">
					{AUTO_SUBMIT_WARNING}
				</p>
				<p className="text-xs text-muted mb-1">An application is submitted without your review only when it matches every rule below:</p>
				<PolicySummary rules={rules} allowance={allowance} />
				<label className="flex gap-2 items-start text-sm mt-3">
					<input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} data-testid="auto-submit-acknowledge" />
					<span>{AUTO_SUBMIT_ACKNOWLEDGEMENT}</span>
				</label>
				{error && <p className="text-xs text-danger mt-2">{error}</p>}
				<div className="flex gap-2 justify-end mt-3">
					<Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
						Cancel
					</Button>
					<Button size="sm" variant="danger" onClick={onConfirm} disabled={!acknowledged || busy} data-testid="auto-submit-confirm-enable">
						Confirm &amp; Enable
					</Button>
				</div>
			</Card>
		</div>
	);
}
