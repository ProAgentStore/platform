import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";

interface Alias {
	email: string;
	displayName: string;
	isPrimary: boolean;
	isDefault: boolean;
	verified: boolean;
	verificationStatus: string;
}

interface GmailIdentity {
	state: "none" | "configured" | "invalid";
	pin: { sendAs: string | null; inboundScope: string[]; previewChars: number } | null;
	aliases: Alias[] | null;
	blockers: Array<{ code: string; message: string }>;
}

interface Props {
	instanceId: string;
	connected: boolean;
}

/**
 * An instance's Gmail sender is separate from the Google account that supplied OAuth. Gmail
 * permits a verified send-as alias (such as an organisation mailbox), but silently rewrites an
 * unverified From header to the primary address. The API therefore supplies this panel's choices
 * from Gmail itself and refuses anything not marked verified; no arbitrary address is editable.
 */
export default function GmailIdentityPanel({ instanceId, connected }: Props) {
	const [identity, setIdentity] = useState<GmailIdentity | null>(null);
	const [sender, setSender] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		if (!connected) {
			setIdentity(null);
			return;
		}
		try {
			const next = await api<GmailIdentity>(`/v1/instances/${encodeURIComponent(instanceId)}/gmail/identity`);
			setIdentity(next);
			setSender(next.pin?.sendAs ?? "");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Gmail sending identities could not be loaded.");
		}
	}, [instanceId, connected]);

	useEffect(() => {
		setMessage("");
		void load();
	}, [load]);

	const save = async () => {
		if (!sender) return;
		setSaving(true);
		setMessage("");
		try {
			await api(`/v1/instances/${encodeURIComponent(instanceId)}/gmail/identity`, {
				method: "PUT",
				// Scope incoming mail to the same organisation mailbox by default. The owner can
				// make a wider, deliberate configuration through the MCP identity tool.
				body: JSON.stringify({ sendAs: sender, inboundScope: [sender] }),
			});
			setMessage(`Saved. This agent sends as ${sender} and is limited to mail addressed to it.`);
			await load();
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Could not save the Gmail sending identity.");
		} finally {
			setSaving(false);
		}
	};

	const clear = async () => {
		setSaving(true);
		setMessage("");
		try {
			await api(`/v1/instances/${encodeURIComponent(instanceId)}/gmail/identity`, {
				method: "PUT",
				body: JSON.stringify({ clear: true }),
			});
			setMessage("Specific Gmail sender removed. This agent will use the connected account's default sender.");
			await load();
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Could not clear the Gmail sending identity.");
		} finally {
			setSaving(false);
		}
	};

	if (!connected) return null;
	const aliases = identity?.aliases ?? [];
	const verified = aliases.filter((alias) => alias.verified);
	const senderBlocked = identity?.blockers.find((blocker) => ["no_gmail_connection", "aliases_unreadable"].includes(blocker.code));

	return (
		<div className="mt-4" data-testid="gmail-identity-panel">
			<div className="text-sm mb-1"><span className="font-semibold">Gmail sending identity</span></div>
			<p className="text-2xs text-muted-soft mb-2">
				Choose the verified address this agent represents. It becomes the explicit From and Reply-To address; Gmail refuses unverified aliases rather than silently using your personal mailbox.
			</p>
			{identity === null ? (
				<p className="text-xs text-muted">Loading Gmail sending identities…</p>
			) : senderBlocked ? (
				<p className="text-xs text-warning">{senderBlocked.message}</p>
			) : (
				<>
					<div className="flex gap-2 flex-wrap">
						<select aria-label="Gmail sending identity" value={sender} disabled={saving || verified.length === 0} onChange={(e) => setSender(e.target.value)} className="flex-1 min-w-0 sm:min-w-[16rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm disabled:opacity-50">
							<option value="">{verified.length === 0 ? "No verified Gmail sending address" : "Choose a verified sender"}</option>
							{verified.map((alias) => <option key={alias.email} value={alias.email}>{alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}{alias.isPrimary ? " (primary)" : ""}</option>)}
						</select>
						<Button onClick={() => void save()} disabled={!sender || saving || sender === identity.pin?.sendAs}>Use this sender</Button>
						{identity.pin?.sendAs && <Button variant="ghost" onClick={() => void clear()} disabled={saving}>Use account default</Button>}
					</div>
					{verified.length === 0 && <p className="text-xs text-warning mt-1">No verified alias is available. Add and verify one in Gmail Settings → Accounts, then reload this page.</p>}
					{identity.pin?.sendAs && <p className="text-xs text-muted mt-1">Current sender: <b>{identity.pin.sendAs}</b>. Incoming mail is scoped to {identity.pin.inboundScope.join(", ") || "the whole connected mailbox"}.</p>}
				</>
			)}
			{message && <p className="text-xs text-muted mt-2">{message}</p>}
		</div>
	);
}
