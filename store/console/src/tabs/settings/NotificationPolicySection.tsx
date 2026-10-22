import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { CHANNEL_HELP, type PolicyChoice, type PolicyRow, policyRows, rulesFromChoices, SOURCE_LABEL } from "../../lib/notificationPolicy";
import type { InstanceNotificationPolicy, NotificationPolicyRule, NotificationVocabulary } from "../../lib/types";

/**
 * At the ACCOUNT level the rules are not this component's to fetch or write (#1283): they are one field of the page's shared
 * notifications store, which writes the whole `notifications` section (mutes, scope and rules) on every change. A copy held here
 * is what let a rule save restore mutes the page had loaded minutes earlier, and a switch erase the rules.
 */
export interface AccountNotificationRules {
	rules: NotificationPolicyRule[];
	/** The server's resolved matrix, refreshed by the store after each write. */
	effective: InstanceNotificationPolicy["effective"];
	/** The first read of the stored settings has landed. */
	ready: boolean;
	/** Why the last load or write failed, or "". */
	error: string;
	/** Apply the new rules to the shared store; `error` is why it was refused, read after the fact (not from a stale render). */
	onChange: (rules: NotificationPolicyRule[]) => Promise<{ ok: boolean; error: string }>;
	onRetry: () => void;
}

/**
 * Settings → Notifications (#992): which notifications THIS agent may send the owner.
 *
 * The three-state control is the whole design. "Inherit" is a real, visible state — not the
 * absence of a choice — because the account below it already says something, and a two-state
 * switch would force every row to be an override the moment the owner touched one of them. Each
 * row therefore shows what it currently resolves to AND where that came from, which is the
 * "inherited/effective-state visibility" the issue asks for: a precedence order nobody can see is
 * one people work around.
 *
 * The effective state is read from the server, never computed here. The resolution algorithm
 * lives in `workers/api/src/lib/notification-policy.ts`; a second copy in the console would be a
 * second answer, and the one the owner reads would be the one that is wrong.
 */
/**
 * `instanceId` absent = the ACCOUNT's own rules, edited on the Preferences page. One component for
 * both levels on purpose: the control, the three states and the "where did this come from" line
 * are the same question at either level, and two copies would drift into two answers.
 */
export default function NotificationPolicySection({ instanceId, account }: { instanceId?: string; account?: AccountNotificationRules }) {
	const [vocab, setVocab] = useState<NotificationVocabulary | null>(null);
	const [policy, setPolicy] = useState<InstanceNotificationPolicy | null>(null);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			const v = await api<NotificationVocabulary>("/v1/instances/notification-vocabulary");
			setVocab(v);
			// Account level: the policy comes from the shared store (below), so only the vocabulary is read here.
			if (instanceId) setPolicy(await api<InstanceNotificationPolicy>(`/v1/instances/${instanceId}/notifications`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
	}, [load]);

	const save = useCallback(
		async (rows: PolicyRow[]) => {
			setSaving(true);
			setMsg("");
			try {
				const rules = rulesFromChoices(rows);
				// An empty list IS "restore inherited", and the route it goes to says so: DELETE
				// removes the override, where a stored `[]` would look like a policy that decides
				// nothing. Same call the MCP tool makes.
				if (instanceId) {
					const next = rules.length
						? await api<InstanceNotificationPolicy>(`/v1/instances/${instanceId}/notifications`, { method: "PUT", body: JSON.stringify({ rules }) })
						: await api<InstanceNotificationPolicy>(`/v1/instances/${instanceId}/notifications`, { method: "DELETE" });
					setPolicy((prev) => (prev ? { ...prev, ...next, inherited: prev.inherited } : prev));
					setMsg("Saved.");
				} else if (account) {
					// One writer for the whole section: the store applies this change to the CURRENT mutes and scope, writes all
					// three, and re-reads the resolved matrix. A refusal puts the rows back to what is stored and says why.
					const done = await account.onChange(rules);
					setMsg(done.ok ? "Saved." : done.error || "Couldn't save that. Try again.");
				}
			} catch (e) {
				setMsg(e instanceof Error ? e.message : String(e));
				// Put the controls back to what is STORED rather than showing a save that did not
				// happen — the same rule the timezone and mute controls follow.
				await load();
			} finally {
				setSaving(false);
			}
		},
		[instanceId, load, account],
	);

	// Shaped as an instance policy so one component renders both: at the account level the owner's own rules ARE the "instance"
	// level of the resolution, which is exactly how the server reports their source.
	const shown: InstanceNotificationPolicy | null = instanceId ? policy : account?.ready ? { instanceId: "", rules: account.rules, effective: account.effective } : null;
	if (!instanceId && account && account.error && !account.ready) return <LoadFailed what="notification settings" detail={account.error} onRetry={account.onRetry} />;
	if (error) return <LoadFailed what="notification settings" detail={error} onRetry={() => void load()} />;
	if (!vocab || !shown) return null;

	const rows = policyRows(vocab, shown);
	const overridden = (shown.rules ?? []).length > 0;

	const setChoice = (row: PolicyRow, channel: "inapp" | "push", choice: PolicyChoice) => {
		void save(rows.map((r) => (r.key === row.key ? { ...r, [channel]: { ...r[channel], choice } } : r)));
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid="instance-notification-policy">
			<h3 className="text-base font-bold mb-1">{instanceId ? "Notifications" : "Notification rules"}</h3>
			<p className="text-xs text-muted mb-3">
				{instanceId ? "What this agent may tell you, and where. " : "Your baseline for every agent, which any agent's own Settings tab can override. "}
				<b>Inherit</b> {instanceId ? "follows your account settings" : "leaves the row to the switches above and the platform default"} — the
				state every row starts in. Turning <b>push</b> off leaves the notification in the console; turning{" "}
				<b>console</b> off removes the record too, so you lose the history for it.
			</p>

			<div className="flex flex-wrap gap-2 mb-3">
				<Button
					variant="secondary"
					disabled={saving}
					onClick={() => void save(rows.map((r) => ({ ...r, inapp: { ...r.inapp, choice: "off" }, push: { ...r.push, choice: "off" } })))}
				>
					Turn everything off
				</Button>
				<Button variant="secondary" disabled={saving || !overridden} onClick={() => void save([])}>
					{instanceId ? "Restore inherited" : "Clear all rules"}
				</Button>
			</div>

			{rows.map((row) => (
				<div key={row.key} className="py-2.5 border-t border-line first:border-t-0">
					<div className="flex items-start justify-between gap-3 flex-wrap">
						<span className="text-sm min-w-0">
							<span className="font-semibold">{row.label}</span>
							<span className="block text-2xs text-muted-soft mt-0.5">{row.description}</span>
						</span>
						<span className="flex gap-3 shrink-0">
							{(["inapp", "push"] as const).map((channel) => (
								<label key={channel} className="text-2xs text-muted-soft flex flex-col gap-1">
									<span title={CHANNEL_HELP[channel]}>{channel === "inapp" ? "Console" : "Push"}</span>
									<select
										className="bg-paper border border-line rounded px-1.5 py-1 text-xs"
										value={row[channel].choice}
										disabled={saving}
										aria-label={`${row.label} — ${channel === "inapp" ? "console" : "push"}`}
										onChange={(e) => setChoice(row, channel, e.target.value as PolicyChoice)}
									>
										<option value="inherit">Inherit</option>
										<option value="on">On</option>
										<option value="off">Off</option>
									</select>
									{/* The effective answer, and who gave it. This is the line that makes the
									    precedence order legible instead of folklore. */}
									<span className="text-2xs">
										{row[channel].allowed ? "on" : "off"} · {SOURCE_LABEL[row[channel].source]}
									</span>
								</label>
							))}
						</span>
					</div>
				</div>
			))}

			{msg && <p className="text-xs text-muted mt-2">{msg}</p>}
		</Card>
	);
}
