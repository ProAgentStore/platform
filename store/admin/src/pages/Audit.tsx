import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { type AuditRow, prettyDetail } from "../lib/moderation";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

/**
 * Every action the moderation API can record. Listed explicitly rather than derived
 * from the loaded rows: an operator filtering for "did anyone ever delete an agent"
 * must be able to ASK, and get an empty answer — deriving the options from the visible
 * page would silently hide the very action nobody has taken yet.
 */
const ACTIONS = [
	"user.suspend",
	"user.unsuspend",
	"user.roles",
	"user.key.revoke",
	"agent.unpublish",
	"agent.delete",
	"instance.cancel",
];

const LIMITS = ["100", "200", "500"];

/**
 * Deep-link the target to the page that owns it, so the log is a way IN, not a dead end.
 * A delete leaves nothing to link to — showing the bare id is honest; a link that 404s
 * would read as a broken portal rather than as "this row is why it's gone".
 */
function targetLink(row: AuditRow) {
	if (!row.target_id) return <span className="text-muted-soft">—</span>;
	const to =
		row.action.endsWith(".delete") ? null
		: row.target_type === "user" ? `/users/${encodeURIComponent(row.target_id)}`
		: row.target_type === "agent" ? `/agents/${encodeURIComponent(row.target_id)}`
		: row.target_type === "instance" ? `/instances/${encodeURIComponent(row.target_id)}`
		: null;
	const label = `${row.target_type ?? "?"}:${row.target_id.slice(0, 12)}`;
	return to ? <Link to={to} className="text-accent hover:underline font-mono text-xs">{label}</Link> : <span className="font-mono text-xs text-muted">{label}</span>;
}

export default function Audit() {
	const [actor, setActor] = useState("");
	const [action, setAction] = useState("");
	const [target, setTarget] = useState("");
	const [limit, setLimit] = useState("200");
	const [applied, setApplied] = useState({ actor: "", action: "", target: "", limit: "200" });
	const [audit, setAudit] = useState<AuditRow[] | null>(null);
	const [err, setErr] = useState("");
	const [open, setOpen] = useState<string | null>(null);

	const qs = useMemo(() => {
		const p = new URLSearchParams();
		if (applied.actor) p.set("actor", applied.actor);
		if (applied.action) p.set("action", applied.action);
		if (applied.target) p.set("target", applied.target);
		p.set("limit", applied.limit);
		return p.toString();
	}, [applied]);

	useEffect(() => {
		setAudit(null);
		setErr("");
		api<{ audit: AuditRow[] }>(`/v1/admin/audit?${qs}`).then((r) => setAudit(r.audit)).catch((e) => setErr(e.message));
	}, [qs]);

	const apply = useCallback(() => {
		setApplied({ actor: actor.trim(), action, target: target.trim(), limit });
	}, [actor, action, target, limit]);

	// The action select and the limit apply immediately; only the free-text fields wait
	// for Enter/Apply, so a half-typed id never fires a query.
	useEffect(() => { setApplied((a) => ({ ...a, action, limit })); }, [action, limit]);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Admin audit log</h1>
			<p className="text-sm text-muted mb-4">
				Every privileged operator action, newest first — who did what to whom, with the before-state. Each detail row expands.
			</p>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<input
					value={actor}
					onChange={(e) => setActor(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && apply()}
					aria-label="Filter audit entries by actor user id"
					placeholder="Actor user id"
					className="!w-auto min-w-[15rem] text-sm"
				/>
				<select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)} className="!w-auto text-sm">
					<option value="">Any action</option>
					{ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
				</select>
				<input
					value={target}
					onChange={(e) => setTarget(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && apply()}
					placeholder="Target id (user / agent / instance)"
					className="!w-auto min-w-[17rem] text-sm"
				/>
				<select aria-label="Number of rows" value={limit} onChange={(e) => setLimit(e.target.value)} className="!w-auto text-sm">
					{LIMITS.map((l) => <option key={l} value={l}>last {l}</option>)}
				</select>
				<button type="button" onClick={apply} className="text-sm px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold">Apply</button>
				{applied.actor || applied.action || applied.target ? (
					<button
						type="button"
						onClick={() => { setActor(""); setAction(""); setTarget(""); setApplied({ actor: "", action: "", target: "", limit }); }}
						className="text-sm px-3 py-1.5 rounded-lg border border-line text-muted hover:bg-panel-hover"
					>
						Clear
					</button>
				) : null}
			</div>

			{err ? <ErrorBox message={err} /> : !audit ? <Loading /> : (
				<Panel title={`Actions (${audit.length})`}>
					{!audit.length ? <Empty label="No admin actions match these filters." /> : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th>
								</tr></thead>
								<tbody>
									{audit.map((a) => (
										<Fragment key={a.id}>
											<tr className="border-b border-line/50 hover:bg-panel-hover align-top">
												<td className="py-1.5 text-muted whitespace-nowrap">{a.created_at?.slice(0, 16)}</td>
												<td className="truncate max-w-[160px] font-mono text-xs">{a.actor_user_id}</td>
												<td className="text-accent whitespace-nowrap">{a.action}</td>
												<td>{targetLink(a)}</td>
												<td>
													{a.detail ? (
														<button type="button" onClick={() => setOpen(open === a.id ? null : a.id)} className="text-xs text-muted hover:text-ink">
															{open === a.id ? "hide ▾" : "show ▸"}
														</button>
													) : <span className="text-muted-soft text-xs">—</span>}
												</td>
											</tr>
											{open === a.id && a.detail ? (
												<tr className="border-b border-line/50">
													<td colSpan={5} className="pb-2">
														<pre className="text-xs text-muted bg-paper border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">{prettyDetail(a.detail)}</pre>
													</td>
												</tr>
											) : null}
										</Fragment>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			)}
		</div>
	);
}
