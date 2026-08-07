import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel, TrendBars } from "../lib/ui";

interface Bucket { key: string; label?: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
interface UsageResp {
	range: string;
	totals: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
	daily: Array<{ date: string; costMicros: number }>;
	byProvider: Bucket[]; byModel: Bucket[]; byKind: Bucket[]; byUser: Bucket[]; byAgent: Bucket[];
	split: { platformPaid: { costMicros: number; calls: number }; byok: { costMicros: number; calls: number } };
}

/**
 * GET /v1/admin/usage/external — mirrors ExternalUsageReport (workers/api/src/lib/external-usage.ts).
 *
 * Two dollar figures, never one (#346): `valueMicros` is list-price value on every row,
 * `chargedMicros` the subset anyone is actually charged. Work run on someone's Claude
 * subscription has the first and not the second.
 */
interface ExternalTotals { calls: number; valueMicros: number; chargedMicros: number }
interface ExternalResp {
	externalUsers: number;
	byAgent: Array<{ agentId: string; externalUsers: number } & ExternalTotals>;
	totals: ExternalTotals;
	operator: { users: number } & ExternalTotals;
	operatorUnknown: boolean;
}

interface AdminUserRow { id: string; github_login: string | null; roles: string[] }

const RANGES = ["7d", "30d", "90d", "all"];
/** The external endpoint takes a rolling day count (clamped 1–365 server-side), not a range id. */
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, all: 365 };
/** splitUsage() groups external rows with no agent_id under this key; the /usage rollup uses "unassigned". */
const UNATTRIBUTED = "(unattributed)";

export default function Usage() {
	const [range, setRange] = useState("30d");
	const [d, setD] = useState<UsageResp | null>(null);
	const [err, setErr] = useState("");
	const [ext, setExt] = useState<ExternalResp | null>(null);
	const [extErr, setExtErr] = useState("");
	// Operator ids for flagging rows in "By user". null = we could not establish the set reliably,
	// in which case NOTHING is flagged — a half-flagged table is worse than an unflagged one,
	// because an unflagged operator row reads as a confirmed external user.
	const [opIds, setOpIds] = useState<Set<string> | null>(null);

	const days = RANGE_DAYS[range] ?? 30;

	useEffect(() => {
		setD(null); setErr("");
		api<UsageResp>(`/v1/admin/usage?range=${range}`).then(setD).catch((e) => setErr(e.message));
	}, [range]);

	useEffect(() => {
		setExt(null); setExtErr("");
		api<ExternalResp>(`/v1/admin/usage/external?days=${days}`).then(setExt).catch((e) => setExtErr(e.message));
	}, [days]);

	// Who is the operator, for the "By user" flags. Derived from users.roles — the SAME live source
	// operatorUserIds() consults — plus the caller, whom requireAdmin has already proven is an admin.
	// ADMIN_ALLOWLIST is server-only and invisible here, so the split panel above stays authoritative.
	useEffect(() => {
		Promise.all([
			api<{ id: string }>("/v1/auth/me"),
			api<{ users: AdminUserRow[]; total: number }>("/v1/admin/users?limit=200"),
		])
			.then(([me, list]) => {
				// A truncated page would silently leave admins past the limit unflagged.
				if (list.total > list.users.length) { setOpIds(null); return; }
				const ids = new Set<string>(list.users.filter((u) => u.roles?.includes("admin")).map((u) => u.id));
				if (me.id) ids.add(me.id);
				setOpIds(ids);
			})
			.catch(() => setOpIds(null));
	}, []);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;

	const agentLabels = new Map(d.byAgent.map((b) => [b.key, b.label || b.key]));

	return (
		<div>
			<div className="flex items-center justify-between mb-3">
				<h1 className="font-display text-xl font-bold">Usage</h1>
				<select aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)} className="!w-auto text-sm">{RANGES.map((r) => <option key={r}>{r}</option>)}</select>
			</div>

			<Panel
				title="External vs operator"
				right={<span className="text-xs text-muted-soft">last {days} days{range === "all" ? " (max)" : ""}</span>}
			>
				{extErr ? (
					<div className="text-red text-sm">Couldn’t measure the split: {extErr}</div>
				) : !ext ? (
					<Loading label="Measuring…" />
				) : (
					<ExternalSplit ext={ext} days={days} agentLabels={agentLabels} />
				)}
			</Panel>

			<Panel title="Cost trend"><TrendBars points={d.daily} /></Panel>
			<div className="grid md:grid-cols-2 gap-4">
				<Panel title="By activity"><BucketTable rows={d.byKind} head="Kind" /></Panel>
				<Panel title="By model"><BucketTable rows={d.byModel} head="Model" /></Panel>
				<Panel title="By provider"><BucketTable rows={d.byProvider} head="Provider" /></Panel>
				<Panel title="By user">
					<BucketTable rows={d.byUser} head="User" operatorIds={ext?.operatorUnknown ? null : opIds} />
					<p className="text-xs text-muted-soft mt-2">
						{ext?.operatorUnknown
							? "Operator rows can’t be flagged — no operator account could be identified."
							: opIds
								? "Operator rows are flagged from the admin role on the account. The split panel above is authoritative."
								: "Operator rows aren’t flagged — the operator set couldn’t be established."}
					</p>
				</Panel>
				<Panel title="By agent"><BucketTable rows={d.byAgent} head="Agent" /></Panel>
			</div>
		</div>
	);
}

/**
 * The #68 metric, stated plainly — plus the one state that must never be shown as a number.
 *
 * When `operatorUnknown` is set, no operator could be identified, so every ledger row looks
 * external and `externalUsers` is meaningless rather than zero. Rendering it anyway would turn
 * the operator's own traffic into a falsely encouraging "we have users", which is the exact
 * failure the endpoint was shaped to prevent — so this branch shows no counts at all.
 */
function ExternalSplit({ ext, days, agentLabels }: { ext: ExternalResp; days: number; agentLabels: Map<string, string> }) {
	if (ext.operatorUnknown) {
		return (
			<div className="border border-yellow/40 bg-yellow/5 rounded-lg p-3">
				<div className="text-yellow font-bold text-sm">Cannot determine</div>
				<p className="text-sm text-muted mt-1">
					No operator account could be identified, so every row in the ledger looks external and the
					count would be meaningless — not zero, and not encouraging. No number is shown on purpose.
				</p>
				<p className="text-xs text-muted-soft mt-2">
					Give an account the <code>admin</code> role, or list it in <code>ADMIN_ALLOWLIST</code>, and this
					resolves on the next load.
				</p>
			</div>
		);
	}

	const none = ext.externalUsers === 0;
	return (
		<div>
			<div className="flex flex-wrap items-baseline gap-2">
				<span className={`text-4xl font-bold tabular-nums ${none ? "" : "text-accent"}`}>{fmtInt(ext.externalUsers)}</span>
				<span className="text-muted">external {ext.externalUsers === 1 ? "user" : "users"} in the last {days} days</span>
			</div>
			{none && (
				<p className="text-sm text-muted-soft mt-1">
					Nobody outside the operator has used the platform in this window. That is a measured zero, not a
					missing measurement.
				</p>
			)}

			{/* Operator activity sits alongside rather than being netted out, so the comparison is visible. */}
			<div className="grid grid-cols-2 gap-3 mt-4">
				<Side label="External" users={ext.externalUsers} totals={ext.totals} accent={!none} />
				<Side label="Operator" users={ext.operator.users} totals={ext.operator} />
			</div>

			<h3 className="text-xs uppercase text-muted mt-5 mb-1.5">External users by agent</h3>
			{ext.byAgent.length === 0 ? (
				<div className="text-muted-soft text-sm">No external usage on any agent in this window.</div>
			) : (
				<table className="w-full text-sm">
					<thead>
						<tr className="text-muted text-xs uppercase text-left border-b border-line">
							<th className="py-1.5">Agent</th>
							<th className="text-right">External users</th>
							<th className="text-right">Calls</th>
							<th className="text-right">Value</th>
							<th className="text-right">Charged</th>
						</tr>
					</thead>
					<tbody>
						{/* Order is the endpoint's: external users desc, then calls — the #68 ranking. */}
						{ext.byAgent.map((a) => (
							<tr key={a.agentId} className="border-b border-line/50">
								<td className="py-1.5 truncate max-w-[180px]">
									{a.agentId === UNATTRIBUTED ? <span className="text-muted-soft">Unattributed</span> : agentLabels.get(a.agentId) || a.agentId}
								</td>
								<td className="text-right tabular-nums">{fmtInt(a.externalUsers)}</td>
								<td className="text-right tabular-nums">{fmtInt(a.calls)}</td>
								<td className="text-right tabular-nums">{fmtUsd(a.valueMicros)}</td>
								<td className="text-right tabular-nums">{fmtUsd(a.chargedMicros)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

function Side({ label, users, totals, accent }: { label: string; users: number; totals: ExternalTotals; accent?: boolean }) {
	return (
		<div className="border border-line rounded-lg p-3">
			<div className={`text-xs uppercase tracking-wide ${accent ? "text-accent" : "text-muted"}`}>{label}</div>
			<div className="text-sm mt-1.5 tabular-nums">
				{fmtInt(users)} {users === 1 ? "user" : "users"} · {fmtInt(totals.calls)} calls
			</div>
			{/* Value first because that is what this panel is asking about — is anyone here? — then
			    the charged subset, so the two are never added together or mistaken for each other. */}
			<div className="text-sm text-muted tabular-nums">{fmtUsd(totals.valueMicros)} value</div>
			<div className="text-xs text-muted-soft tabular-nums">{fmtUsd(totals.chargedMicros)} charged</div>
		</div>
	);
}

function BucketTable({ rows, head, operatorIds }: { rows: Bucket[]; head: string; operatorIds?: Set<string> | null }) {
	if (!rows?.length) return <div className="text-muted-soft text-sm">None.</div>;
	return (
		<table className="w-full text-sm">
			<thead><tr className="text-muted text-xs uppercase text-left border-b border-line"><th className="py-1.5">{head}</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
			<tbody>
				{rows.map((b) => (
					<tr key={b.key} className="border-b border-line/50">
						<td className="py-1.5 truncate max-w-[180px]">
							{b.label || b.key}
							{operatorIds?.has(b.key) && (
								<span className="ml-1.5 text-[10px] uppercase tracking-wide text-accent border border-accent/40 rounded px-1 py-px align-middle">operator</span>
							)}
						</td>
						<td className="text-right">{fmtInt(b.calls)}</td>
						<td className="text-right">{fmtInt(b.inputTokens + b.outputTokens)}</td>
						<td className="text-right">{fmtUsd(b.costMicros)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
