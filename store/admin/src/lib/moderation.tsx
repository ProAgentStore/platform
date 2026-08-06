import { useCallback, useEffect, useReducer, useState } from "react";
import { ApiError, api } from "./api";
import {
	blockedCount,
	canConfirm,
	confirmAction,
	dangerReducer,
	failureEvent,
	initialDangerState,
	runArgs,
} from "./danger";
import { Empty } from "./ui";

/**
 * Shared moderation controls for the operator portal (issues #34 API, #41 UI).
 *
 * These are the destructive levers. The API already enforces the safety shape —
 * agent delete must echo the slug and 409s while subscribers are live, key revoke
 * demands an explicit provider, self-suspension and self-demotion are refused. The
 * job of this file is to EXPRESS those constraints rather than paper over them:
 *
 *  - Nothing destructive fires on one click. Opening the control is a separate act
 *    from confirming it, and a `confirmPhrase` (the agent's own slug) has to be typed
 *    exactly — so a mis-click, or the wrong row, cannot destroy anything.
 *  - A 409 is not "it failed". It is the platform saying "there are N live
 *    subscribers"; the operator is shown that number and must then choose the
 *    explicitly-labelled forcing action. Force is never sent on the first attempt,
 *    so nobody force-deletes without having read the count.
 *  - Every action reports what actually happened, and the audit trail sitting next to
 *    it refreshes — an operator sees their action land in the log they are audited by.
 *
 * All three of those now live in `danger.ts` as a pure reducer, and this component is a
 * renderer over it (#282). They were previously local `useState` inside this JSX, which
 * meant the repo's most destructive guards were the one thing its test suite could not
 * reach.
 */

export interface DangerActionProps {
	/** Button label, e.g. "Delete agent". */
	label: string;
	/** One line saying exactly what will happen, in the operator's terms. */
	description: string;
	/** When set, the operator must type this string EXACTLY before confirming. */
	confirmPhrase?: string;
	/** Ask for a free-text reason (stored + audited). */
	withReason?: boolean;
	/** Allow the confirm to be retried with `force` after the API refuses with a 409. */
	forceable?: boolean;
	/** Label for the second, explicit forcing button once the 409 has been read. */
	forceLabel?: string;
	/** Render as the quiet (non-destructive) variant — unpublish, unsuspend, roles. */
	tone?: "danger" | "neutral";
	disabled?: boolean;
	/** Why the control is unavailable (e.g. "You cannot suspend your own account"). */
	disabledReason?: string;
	/**
	 * Perform the action. Resolve with a short success line; reject to show the error.
	 *
	 * `confirmed` is what the operator TYPED into the echo box — pass it to the request
	 * builder rather than substituting the known-good phrase from props, so the server's
	 * echo check validates the same string the UI gated on.
	 */
	run: (opts: { reason?: string; force?: boolean; confirmed?: string }) => Promise<string>;
	/** Called after a successful run — refresh the page data and the audit trail. */
	onDone?: () => void;
}

export function DangerAction({
	label,
	description,
	confirmPhrase,
	withReason,
	forceable,
	forceLabel,
	tone = "danger",
	disabled,
	disabledReason,
	run,
	onDone,
}: DangerActionProps) {
	const [state, dispatch] = useReducer(dangerReducer, initialDangerState);
	const { open, typed, reason, busy, blocked, error: err, ok } = state;

	const danger = tone === "danger";
	// The echo gate and the force decision are BOTH read off the reducer. This component
	// never computes either — see danger.test.ts.
	const armed = canConfirm(state, confirmPhrase);
	const action = confirmAction(state);

	async function go() {
		dispatch({ type: "submit" });
		try {
			dispatch({ type: "succeeded", message: await run(runArgs(state)) });
			onDone?.();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			dispatch(failureEvent(e instanceof ApiError ? e.status : null, message, !!forceable));
		}
	}

	if (disabled) {
		return (
			<div className="text-sm">
				<span className="text-muted-soft">{label}</span>
				{disabledReason ? <span className="text-muted-soft text-xs"> — {disabledReason}</span> : null}
			</div>
		);
	}

	if (!open) {
		return (
			<div>
				<button
					type="button"
					onClick={() => dispatch({ type: "open" })}
					className={`text-sm px-3 py-1.5 rounded-lg border ${
						danger ? "border-red/40 text-red hover:bg-red/10" : "border-line text-ink hover:bg-panel-hover"
					}`}
				>
					{label}
				</button>
				{ok ? <span className="text-green text-xs ml-2">{ok}</span> : null}
			</div>
		);
	}

	const blockedN = blocked ? blockedCount(blocked) : null;

	return (
		<div className={`rounded-lg border p-3 ${danger ? "border-red/40" : "border-line"}`}>
			<div className="text-sm font-semibold mb-1">{label}</div>
			<p className="text-xs text-muted mb-2">{description}</p>

			{withReason ? (
				<input
					value={reason}
					onChange={(e) => dispatch({ type: "reason", value: e.target.value })}
					placeholder="Reason (recorded in the audit log)"
					className="text-sm mb-2"
				/>
			) : null}

			{confirmPhrase ? (
				<label className="block text-xs text-muted mb-2">
					Type <span className="font-mono text-ink">{confirmPhrase}</span> to confirm
					<input
						value={typed}
						onChange={(e) => dispatch({ type: "typed", value: e.target.value })}
						className="text-sm mt-1"
						autoComplete="off"
						data-testid="danger-echo"
					/>
				</label>
			) : null}

			{blocked ? (
				<div className="text-xs text-yellow border border-yellow/40 rounded-lg p-2 mb-2">
					{blockedN != null
						? `${blockedN} live subscriber instance(s) are still attached. Forcing cancels them as part of the delete.`
						: blocked}
					<div className="text-muted-soft mt-1">{blocked}</div>
				</div>
			) : null}
			{err ? <div className="text-xs text-red mb-2">{err}</div> : null}

			<div className="flex items-center gap-2">
				{/* One button, two labels. Which one is showing is `confirmAction(state)`,
				    and whether it sends force is `runArgs(state)` — the component picks
				    neither, so a first attempt structurally cannot force. */}
				<button
					type="button"
					disabled={!armed}
					onClick={go}
					className={
						action === "force"
							? "text-sm px-3 py-1.5 rounded-lg bg-red text-white disabled:opacity-40"
							: `text-sm px-3 py-1.5 rounded-lg text-white disabled:opacity-40 ${danger ? "bg-red" : "bg-accent hover:bg-accent-hover"}`
					}
				>
					{busy ? "Working…" : action === "force" ? (forceLabel ?? "Force") : "Confirm"}
				</button>
				<button
					type="button"
					onClick={() => dispatch({ type: "cancel" })}
					className="text-sm px-3 py-1.5 rounded-lg border border-line hover:bg-panel-hover"
				>
					Cancel
				</button>
			</div>
		</div>
	);
}

export interface AuditRow {
	id: string;
	created_at: string;
	actor_user_id: string;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail: string | null;
}

/**
 * The audit log for ONE target, rendered next to that target's controls.
 *
 * The audit page is the cross-cutting view; this is the local one, and it exists
 * because "what has already been done to this account/agent/instance" is a question
 * an operator has at the moment of acting, not later in a separate silo. `refresh`
 * is bumped by the actions above it, so a freshly taken action appears immediately.
 */
export function AuditTrail({ targetId, refresh = 0, limit = 20 }: { targetId: string; refresh?: number; limit?: number }) {
	const [rows, setRows] = useState<AuditRow[] | null>(null);
	const [err, setErr] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is a deliberate refetch SIGNAL, not data this effect reads — an action above bumps it so the trail reloads and the operator sees their own action land
	useEffect(() => {
		let live = true;
		setRows(null);
		setErr("");
		api<{ audit: AuditRow[] }>(`/v1/admin/audit?target=${encodeURIComponent(targetId)}&limit=${limit}`)
			.then((r) => { if (live) setRows(r.audit); })
			.catch((e) => { if (live) setErr(e.message); });
		return () => { live = false; };
	}, [targetId, refresh, limit]);

	if (err) return <div className="text-red text-sm">{err}</div>;
	if (!rows) return <div className="text-muted text-sm">Loading…</div>;
	if (!rows.length) return <Empty label="No operator actions recorded against this target." />;

	return (
		<div className="space-y-1">
			{rows.map((r) => (
				<AuditLine key={r.id} row={r} />
			))}
		</div>
	);
}

/** One audit row; the detail JSON (incl. the before-state) expands on demand. */
export function AuditLine({ row, actorLabel }: { row: AuditRow; actorLabel?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="text-sm border-b border-line/50 py-1">
			<button type="button" onClick={() => setOpen((v) => !v)} className="text-left w-full hover:bg-panel-hover rounded px-1 -mx-1">
				<span className="text-muted-soft text-xs">{row.created_at?.slice(0, 16)} </span>
				<span className="text-accent">{row.action}</span>
				<span className="text-muted text-xs"> by {actorLabel ?? row.actor_user_id}</span>
				{row.detail ? <span className="text-muted-soft text-xs"> {open ? "▾" : "▸"}</span> : null}
			</button>
			{open && row.detail ? (
				<pre className="text-xs text-muted bg-paper border border-line rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all">
					{prettyDetail(row.detail)}
				</pre>
			) : null}
		</div>
	);
}

export function prettyDetail(detail: string): string {
	try {
		return JSON.stringify(JSON.parse(detail), null, 2);
	} catch {
		return detail;
	}
}

/**
 * The signed-in operator's own user id, for the controls that must not target self.
 * The API refuses self-suspension and self-demotion outright; knowing the id lets the
 * UI say so up front instead of offering a button that can only ever error.
 */
export function useSelfId(): string | null {
	const [id, setId] = useState<string | null>(null);
	const load = useCallback(() => {
		api<{ id: string }>("/v1/auth/me").then((m) => setId(m.id)).catch(() => setId(null));
	}, []);
	useEffect(load, [load]);
	return id;
}
