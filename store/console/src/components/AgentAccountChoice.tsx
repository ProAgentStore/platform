import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import LoadFailed from "./LoadFailed";
import {
	accountRows,
	agentAccountChoices,
	agentAccountNotice,
	NO_ACCOUNT_CHOSEN_LABEL,
	type InstanceConnectorAccounts,
} from "../lib/accountConnections";

/**
 * Which of the owner's accounts THIS agent uses, for every connector holding more than one (#736).
 *
 * ── The hole this fills
 *
 * `lib/connector-accounts.ts` refuses every call on a connector with two accounts and no per-agent
 * choice, and it is right to: resolving to an arbitrary mailbox "silently answers from the wrong
 * life". Three surfaces then told the owner to make that choice "in its Settings" — the runtime
 * refusal, the stale-pin refusal, and the Preferences page's own note under the account list — and
 * the control was never built. #715 closed saying it would be filed separately and it was not.
 * Measured on the live API 2026-08-23: `blocked.reason: "ambiguous"` on the Job Application
 * Assistant while `/v1/email/status` reported `connected: true` and the permission showed ticked.
 * The only way out was a hand-written `curl`.
 *
 * ── It CHOOSES, it never CONNECTS
 *
 * There is no connect or disconnect affordance here and there must never be one. That is the line
 * #355 drew after disconnecting Gmail from the Coder's settings silently disconnected it for every
 * other agent: connecting is an ACCOUNT act — one credential row shared by every instance — and a
 * button that performs it under a heading carrying one agent's name is a comprehension bug on a
 * permission surface. `PUT /v1/instances/{id}/connector-accounts` enforces the same line on the
 * server (`routes/tools.ts`), refusing any account the owner does not already hold, and
 * `accountConnections.test.ts` asserts this file offers no such control.
 *
 * ── Generic over connectors, on purpose
 *
 * No `if (connector === "gmail")`. Gmail is simply the connector that reached two accounts first;
 * Drive and WorkDrive resolve through the identical code path and will arrive here for free. The
 * account page's whole design rests on there being no per-connector knowledge in the console, and
 * one `if` is all it takes to lose it.
 *
 * ── Why a failed read is not silence
 *
 * A dropped request must not render as "nothing to choose". The empty state and the failure state
 * look identical — no panel — and the empty state is a claim that this agent's connectors are
 * unambiguous, which is exactly the claim that was false when this issue was filed (#291's rule:
 * a fallback indistinguishable from a real answer is the dangerous one).
 */
export interface AgentAccountChoiceProps {
	instanceId: string;
}

export default function AgentAccountChoice({ instanceId }: AgentAccountChoiceProps) {
	const [rows, setRows] = useState<InstanceConnectorAccounts[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState("");

	const load = useCallback(async () => {
		setLoadErr("");
		try {
			const d = await api<{ connectors?: InstanceConnectorAccounts[] }>(`/v1/instances/${instanceId}/connector-accounts`);
			setRows(d.connectors || []);
		} catch (e) {
			setRows(null);
			setLoadErr(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	async function choose(connector: string, accountId: string) {
		setSaving(connector);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/connector-accounts`, {
				method: "PUT",
				body: JSON.stringify({ connector, accountId: accountId || null }),
			});
			// Re-read rather than patch local state: `resolves` and `blocked` are the SERVER's
			// verdict on the pin just written, and a locally-computed guess at them is how a panel
			// comes to disagree with the resolver it is configuring.
			await load();
			setMsg(accountId ? "Saved." : "Choice cleared — this agent will refuse until you pick one.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving("");
		}
	}

	if (loadErr) {
		return (
			<div className="mb-4">
				<LoadFailed compact what="which accounts this agent uses" detail={loadErr} onRetry={() => void load()} testId="agent-accounts-failed" />
			</div>
		);
	}

	const choices = rows ? agentAccountChoices(rows) : [];
	// Nothing renders for the ordinary one-account case, so nobody who never adds a second sees a
	// change — the same threshold `needsPerAgentChoice` already applies on the account page.
	if (choices.length === 0) return null;

	return (
		<div className="mt-4" data-testid="agent-account-choice">
			<div className="text-sm mb-2">
				<span className="font-semibold">Which account this agent uses</span>
			</div>
			<p className="text-2xs text-muted-soft mb-2">
				You have more than one account connected on these. This agent reaches the one you pick here, and
				nothing else. Adding or removing an account is account-wide and stays in <b>Preferences → Connections</b>.
			</p>
			{choices.map((row) => {
				const notice = agentAccountNotice(row);
				return (
					<div key={row.connector} className="mb-3 last:mb-0">
						<label className="block text-xs text-muted mb-1" htmlFor={`account-${row.connector}`}>
							{row.label}
						</label>
						<select
							id={`account-${row.connector}`}
							value={row.pinned ?? ""}
							disabled={saving === row.connector}
							onChange={(e) => void choose(row.connector, e.target.value)}
							className="w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm disabled:opacity-50"
						>
							<option value="">{NO_ACCOUNT_CHOSEN_LABEL}</option>
							{accountRows(row).map((a) => (
								<option key={a.accountId} value={a.accountId}>{a.name}</option>
							))}
						</select>
						{/* The server's own sentence, verbatim when it has one. It is the same string the
						    tool refusal quotes, so the panel and the failure cannot describe the state
						    differently — and it states the consequence, which is what stops the select
						    above from reading as an optional preference. */}
						<p className={`text-2xs mt-1 ${notice.blocked ? "text-warning" : "text-muted-soft"}`}>{notice.message}</p>
					</div>
				);
			})}
			{msg && <div className="text-xs text-muted mt-2">{msg}</div>}
		</div>
	);
}
