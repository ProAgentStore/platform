import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtUsd } from "../lib/api";
import { AuditTrail, DangerAction, useSelfId } from "../lib/moderation";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface UserDetailResp {
	user: {
		id: string;
		github_login: string;
		github_name: string;
		roles: string[];
		subscription_status: string | null;
		created_at: string;
		updated_at: string;
		spend30dMicros: number;
		suspended: boolean;
		suspended_at: string | null;
		suspended_reason: string | null;
	};
	agents: Array<{ id: string; slug: string; name: string; visibility: string; status: string }>;
	instances: Array<{ id: string; agent_name: string | null; status: string }>;
	keyProviders: Array<{ provider: string; last_used_at: string | null }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; status: number | null; message: string }>;
}

/** The roles an operator may assign. `user` is implied by the API and never removable. */
const GRANTABLE = ["creator", "admin"];

export default function UserDetail() {
	const { id } = useParams();
	const selfId = useSelfId();
	const [d, setD] = useState<UserDetailResp | null>(null);
	const [err, setErr] = useState("");
	const [refresh, setRefresh] = useState(0);

	const load = useCallback(() => {
		if (!id) return;
		api<UserDetailResp>(`/v1/admin/users/${encodeURIComponent(id)}`).then(setD).catch((e) => setErr(e.message));
	}, [id]);
	useEffect(load, [load]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;
	const u = d.user;
	const isSelf = !!selfId && selfId === u.id;
	const done = () => { load(); setRefresh((n) => n + 1); };

	return (
		<div>
			<Link to="/users" className="text-sm text-muted hover:text-ink">← Users</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1">
				{u.github_login}
				{u.suspended ? <span className="text-red text-base font-normal ml-2">suspended</span> : null}
				{isSelf ? <span className="text-muted-soft text-base font-normal ml-2">(you)</span> : null}
			</h1>
			<p className="text-sm text-muted mb-4">
				{u.github_name} · roles: {u.roles.join(", ")} · sub: {u.subscription_status || "none"} · spend 30d: {fmtUsd(u.spend30dMicros)} · joined {u.created_at?.slice(0, 10)}
			</p>

			{u.suspended ? (
				<div className="border border-red/40 text-sm rounded-xl p-3 mb-4">
					<span className="text-red font-semibold">Account suspended</span>
					{u.suspended_at ? <span className="text-muted"> since {u.suspended_at.slice(0, 16)}</span> : null}
					{u.suspended_reason ? <div className="text-muted mt-1">Reason: {u.suspended_reason}</div> : null}
					<div className="text-muted-soft text-xs mt-1">Enforced at every authenticated request, not just at sign-in.</div>
				</div>
			) : null}

			<Panel title="Moderation">
				<p className="text-xs text-muted mb-3">
					Each action needs an explicit confirm and lands in the audit trail below, with the before-state.
					{isSelf ? " Actions that would lock you out of this portal are refused." : ""}
				</p>
				<div className="flex flex-wrap items-start gap-3 mb-3">
					{u.suspended ? (
						<DangerAction
							label="Unsuspend"
							tone="neutral"
							description="Restores access immediately (the gate reads the live column, so it takes effect on the next request)."
							run={async () => {
								await api(`/v1/admin/users/${encodeURIComponent(u.id)}/unsuspend`, { method: "POST" });
								return "Unsuspended.";
							}}
							onDone={done}
						/>
					) : (
						<DangerAction
							label="Suspend account"
							description="Blocks every authenticated request from this account until unsuspended. Reversible; the reason is stored."
							withReason
							confirmPhrase={u.github_login}
							disabled={isSelf}
							disabledReason={isSelf ? "you cannot suspend your own account" : undefined}
							run={async ({ reason }) => {
								await api(`/v1/admin/users/${encodeURIComponent(u.id)}/suspend`, { method: "POST", body: JSON.stringify({ reason }) });
								return "Suspended.";
							}}
							onDone={done}
						/>
					)}
				</div>
				{/* Keyed on the persisted roles so a successful save remounts the editor
				    against the NEW truth instead of keeping the pre-save checkbox state. */}
				<RolesEditor key={u.roles.join(",")} user={u} isSelf={isSelf} onDone={done} />
			</Panel>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title={`Agents (${d.agents.length})`}>
					{d.agents.length ? d.agents.map((a) => (
						<div key={a.id} className="text-sm border-b border-line/50 py-1">
							<Link to={`/agents/${encodeURIComponent(a.slug || a.id)}`} className="text-accent hover:underline">{a.name}</Link>
							<span className="text-muted-soft text-xs"> {a.visibility}/{a.status}</span>
						</div>
					)) : <Empty label="None." />}
				</Panel>
				<Panel title={`Instances (${d.instances.length})`} right={<Link to={`/instances?owner=${encodeURIComponent(u.github_login)}`} className="text-xs text-accent hover:underline">Open in Instances →</Link>}>
					{d.instances.length ? d.instances.map((i) => (
						<div key={i.id} className="text-sm border-b border-line/50 py-1">
							<Link to={`/instances/${i.id}`} className="text-accent hover:underline">{i.agent_name || "?"}</Link>
							<span className="text-muted-soft text-xs"> {i.status}</span>
						</div>
					)) : <Empty label="None." />}
				</Panel>

				{/* Key revocation is per PROVIDER, one button per stored key. There is no
				    "revoke all": an omitted provider must never mean "wipe everything". */}
				<Panel title={`API keys (${d.keyProviders.length})`}>
					{d.keyProviders.length ? d.keyProviders.map((k) => (
						<div key={k.provider} className="flex items-center justify-between gap-3 border-b border-line/50 py-2">
							<div className="text-sm">
								{k.provider} <span className="text-muted-soft text-xs">{k.last_used_at ? `used ${k.last_used_at.slice(0, 10)}` : "unused"}</span>
							</div>
							<DangerAction
								label="Revoke"
								description={`Deletes this user's stored ${k.provider} key. The key is never decrypted or shown; only the provider name is audited. Their agents stop working until they add a new one.`}
								confirmPhrase={k.provider}
								run={async () => {
									await api(`/v1/admin/users/${encodeURIComponent(u.id)}/keys/revoke`, { method: "POST", body: JSON.stringify({ provider: k.provider }) });
									return `Revoked ${k.provider}.`;
								}}
								onDone={done}
							/>
						</div>
					)) : <Empty label="No stored provider keys." />}
				</Panel>

				<Panel title={`Recent errors (${d.recentErrors.length})`}>
					{d.recentErrors.length ? d.recentErrors.map((e) => (
						<div key={e.id} className="text-sm border-b border-line/50 py-1">
							<span className="text-muted-soft text-xs">{e.created_at?.slice(5, 16)} [{e.source}] </span>{e.message}
						</div>
					)) : <Empty label="None." />}
				</Panel>
			</div>

			<Panel title="Admin audit trail">
				<AuditTrail targetId={u.id} refresh={refresh} />
			</Panel>
		</div>
	);
}

/**
 * Role grants. The API takes the FULL list (set, not patch) and always implies `user`,
 * so the control is a checkbox set over the grantable roles rather than a grant/revoke
 * pair with its own "revoke a role that isn't there" semantics. Removing your own admin
 * role is refused server-side — it would lock the operator out mid-request — so the
 * checkbox for it is disabled rather than offered and then rejected.
 */
function RolesEditor({ user, isSelf, onDone }: { user: UserDetailResp["user"]; isSelf: boolean; onDone: () => void }) {
	const [sel, setSel] = useState<string[]>(user.roles.filter((r) => r !== "user"));
	const next = ["user", ...sel];
	const changed = JSON.stringify([...next].sort()) !== JSON.stringify([...user.roles].sort());

	return (
		<div className="border-t border-line/50 pt-3">
			<div className="text-sm font-semibold mb-1">Roles</div>
			<div className="flex flex-wrap items-center gap-4 mb-2">
				<label className="text-sm text-muted-soft flex items-center gap-1.5">
					<input type="checkbox" checked disabled className="!w-auto" /> user <span className="text-xs">(always)</span>
				</label>
				{GRANTABLE.map((r) => {
					const lockSelfAdmin = isSelf && r === "admin" && user.roles.includes("admin");
					return (
						<label key={r} className={`text-sm flex items-center gap-1.5 ${lockSelfAdmin ? "text-muted-soft" : ""}`}>
							<input
								type="checkbox"
								className="!w-auto"
								checked={sel.includes(r)}
								disabled={lockSelfAdmin}
								onChange={(e) => setSel((s) => (e.target.checked ? [...new Set([...s, r])] : s.filter((x) => x !== r)))}
							/>
							{r}
							{lockSelfAdmin ? <span className="text-xs">(cannot remove your own)</span> : null}
						</label>
					);
				})}
			</div>
			<DangerAction
				label="Save roles"
				tone="neutral"
				description={`Sets the role list to [${next.join(", ")}] (was [${user.roles.join(", ")}]). Takes effect on the user's next request, not their next sign-in.`}
				disabled={!changed}
				disabledReason={!changed ? "no change" : undefined}
				run={async () => {
					await api(`/v1/admin/users/${encodeURIComponent(user.id)}/roles`, { method: "PUT", body: JSON.stringify({ roles: next }) });
					return "Roles updated.";
				}}
				onDone={onDone}
			/>
		</div>
	);
}
