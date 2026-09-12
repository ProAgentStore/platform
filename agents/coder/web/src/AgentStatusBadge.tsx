import { sessionBadge, type RepoState } from "./repo-status";

/**
 * Working / Idle / Error badge for the open session (CODER-005). The reconciliation of runState
 * and runner connectivity is ./repo-status's; this renders its verdict. Compact on mobile: the
 * coloured dot is always shown (with a tooltip); the text label appears from `sm` up so it fits
 * the 48px header.
 */
export default function AgentStatusBadge({ state }: { state: RepoState }) {
	const { label, tone } = sessionBadge(state);
	const working = tone === "working";
	const error = tone === "error";
	const base = "inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded shrink-0";
	if (working) {
		return (
			<span className={`${base} bg-amber-500/15 text-amber-600`} title={label}>
				<span className="inline-block w-2 h-2 border-2 border-amber-500/40 border-t-amber-600 rounded-full animate-spin" />
				<span className="hidden sm:inline">{label}</span>
			</span>
		);
	}
	return (
		<span className={`${base} ${error ? "bg-danger-soft text-danger" : "bg-success-soft text-success"}`} title={label}>
			<span className={`w-2 h-2 rounded-full ${error ? "bg-danger" : "bg-success"}`} />
			<span className="hidden sm:inline">{label}</span>
		</span>
	);
}
