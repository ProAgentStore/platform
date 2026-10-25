import Button from "./Button";
import Card from "./Card";
import type { MachineRollback } from "../lib/machineDetail";
import { rollbackLine } from "../lib/machineRollbacks";

interface Props {
	rollbacks: MachineRollback[];
	/** The rolled-back release that is also the latest published one — the only one a retry can install. */
	retryable: MachineRollback | null;
	connected: boolean;
	busy: boolean;
	note: string;
	onRetry: () => void;
}

const when = (iso: string | null) => {
	const at = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(at) ? new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "time unknown";
};

/**
 * Releases this machine installed and rolled back from (#1150): from, to, why, when — durable, unlike the one-report
 * `last_error` they used to be. Auto-update and a plain update refuse a rolled-back release for good; "Retry" asks the
 * machine to clear that mark for the latest release and install it on trial again.
 */
export default function MachineRollbacksCard({ rollbacks, retryable, connected, busy, note, onRetry }: Props) {
	if (!rollbacks.length) return null;
	return (
		<Card className="p-4" data-testid="machine-rollbacks">
			<h2 className="font-semibold text-sm mb-1">Rolled-back releases</h2>
			<p className="text-xs text-muted mb-3">This machine tried these releases and went back, so it will not install them again by itself.</p>
			<ul className="text-sm flex flex-col gap-2">
				{rollbacks.map((r) => (
					<li key={r.from} data-testid="machine-rollback">
						<span className="font-mono">{r.from}</span> <span className="text-muted">→ {r.to ?? "previous release"}</span> <span className="text-xs text-muted-soft">· {when(r.at)}</span>
						<div className="text-warning">{rollbackLine(r)}</div>
					</li>
				))}
			</ul>
			{retryable ? (
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<Button onClick={onRetry} disabled={busy || !connected} data-testid="machine-rollback-retry">Retry {retryable.from}</Button>
					{!connected && <span className="text-xs text-muted">The machine is offline.</span>}
				</div>
			) : (
				<p className="text-xs text-muted mt-3" data-testid="machine-rollback-newer">A newer release than these installs as usual.</p>
			)}
			{note && <p role="status" className="text-xs text-muted mt-2" data-testid="machine-rollback-note">{note}</p>}
		</Card>
	);
}
