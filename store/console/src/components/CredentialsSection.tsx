import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { Credential, CredentialSecrets } from "../lib/types";
import { strongPassword } from "../lib/strongPassword";
import Button from "./Button";
import Card from "./Card";

/**
 * The owner's site logins for this agent (#1226): list them, reveal and copy a password to sign in
 * yourself, add one, change or rotate one, delete one.
 *
 * Everything here goes through the vault routes that already existed (`routes/credentials.ts`); the
 * list was read-only until now, so a stored password could be used by the agent but never seen or
 * changed by the person it belongs to.
 *
 *  - The list carries no secret. A password is fetched only on Reveal, from the owner-only route the
 *    API AUDITS (`credential.reveal` in the trace, #639), and is dropped from the page on Hide or when
 *    the section unmounts. Copy needs a reveal first, so every copy is a recorded reveal.
 *  - Editing never shows the current password: a blank "New password" keeps it (the route leaves a
 *    secret unchanged unless one is supplied), so changing a username cannot wipe a login.
 *  - Generate fills a strong password in the browser (`lib/strongPassword.ts`) for a rotation; it is
 *    saved only when the owner presses Save.
 */
type Draft = { id: string | null; domain: string; loginUrl: string; username: string; password: string; comments: string };

const inputClass = "w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm";
const blank: Draft = { id: null, domain: "", loginUrl: "", username: "", password: "", comments: "" };

export default function CredentialsSection({ instanceId, credentials, reload }: { instanceId: string; credentials: Credential[]; reload: () => Promise<void> | void }) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [showPassword, setShowPassword] = useState(false);
	const [revealed, setRevealed] = useState<Record<string, CredentialSecrets>>({});
	const [copied, setCopied] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const base = `/v1/instances/${encodeURIComponent(instanceId)}/credentials`;

	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const save = (d: Draft) =>
		run(async () => {
			const body = {
				...(d.id ? {} : { domain: d.domain.trim() || d.loginUrl.trim() }),
				loginUrl: d.loginUrl.trim() || undefined,
				username: d.username.trim() || undefined,
				comments: d.comments.trim() || undefined,
				// A blank password on an edit keeps the stored one; on a new login it stores none.
				...(d.password ? { password: d.password } : {}),
			};
			await api(d.id ? `${base}/${encodeURIComponent(d.id)}` : base, { method: d.id ? "PUT" : "POST", body: JSON.stringify(body) });
			if (d.id) setRevealed(({ [d.id as string]: _, ...rest }) => rest); // a rotated password is not the one on screen
			setDraft(null);
			setShowPassword(false);
			await reload();
		});

	const reveal = (c: Credential) =>
		run(async () => {
			const secrets = await api<CredentialSecrets>(`${base}/${encodeURIComponent(c.id)}/reveal`);
			setRevealed((r) => ({ ...r, [c.id]: { password: secrets.password, pin: secrets.pin, recoveryCodes: secrets.recoveryCodes } }));
		});

	const copy = async (id: string, value: string) => {
		const ok = await navigator.clipboard?.writeText(value).then(() => true, () => false);
		setCopied(ok ? id : null);
		if (!ok) setError("The browser refused the clipboard — select the password and copy it yourself.");
	};

	const remove = (c: Credential) => {
		if (!confirm(`Delete the stored login for ${c.domain}? The agent will no longer be able to sign in there with it.`)) return;
		void run(async () => {
			await api(`${base}/${encodeURIComponent(c.id)}`, { method: "DELETE" });
			await reload();
		});
	};

	const form = draft && (
		<Card data-testid="credential-form" className="mb-3">
			<div className="text-sm font-semibold mb-2">{draft.id ? `Change the login for ${draft.domain}` : "Add a login"}</div>
			<div className="flex flex-col gap-2">
				{!draft.id && <input aria-label="Site (domain)" placeholder="seek.com.au" value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} className={inputClass} />}
				<input aria-label="Sign-in page (optional)" placeholder="https://… sign-in page (optional)" value={draft.loginUrl} onChange={(e) => setDraft({ ...draft, loginUrl: e.target.value })} className={inputClass} />
				<input aria-label="Username or email" placeholder="Username or email" autoComplete="off" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} className={inputClass} />
				<div className="flex gap-2">
					<input
						aria-label={draft.id ? "New password (blank keeps the current one)" : "Password"}
						placeholder={draft.id ? "New password — leave blank to keep the current one" : "Password"}
						type={showPassword ? "text" : "password"}
						autoComplete="new-password"
						value={draft.password}
						onChange={(e) => setDraft({ ...draft, password: e.target.value })}
						className={`${inputClass} flex-1 min-w-0 font-mono`}
					/>
					<Button size="sm" onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</Button>
					<Button size="sm" onClick={() => { setDraft({ ...draft, password: strongPassword() }); setShowPassword(true); }}>Generate</Button>
				</div>
				<input aria-label="Notes (optional)" placeholder="Notes (optional)" value={draft.comments} onChange={(e) => setDraft({ ...draft, comments: e.target.value })} className={inputClass} />
				<div className="flex gap-2">
					<Button variant="primary" disabled={busy || (!draft.id && !draft.domain.trim() && !draft.loginUrl.trim())} onClick={() => void save(draft)}>Save</Button>
					<Button onClick={() => { setDraft(null); setShowPassword(false); }}>Cancel</Button>
				</div>
			</div>
		</Card>
	);

	return (
		<div data-testid="credentials-section">
			{error && <div role="alert" className="text-xs px-3 py-2 mb-2 rounded-lg bg-danger-soft border border-danger-line text-danger break-words">{error}</div>}
			{form}
			{!draft && (
				<div className="mb-3">
					<Button size="sm" onClick={() => setDraft({ ...blank })}>Add a login</Button>
				</div>
			)}
			{credentials.length === 0 ? (
				<p className="text-center py-4 text-muted-soft text-sm">No credentials saved yet.</p>
			) : (
				<div className="flex flex-col gap-2">
					{credentials.map((c) => {
						const secret = revealed[c.id];
						return (
							<Card key={c.id} data-testid="credential-row">
								<div className="flex items-start justify-between gap-2 flex-wrap">
									<div className="min-w-0">
										<div className="font-semibold text-sm break-all">{c.domain}</div>
										{c.username && <div className="text-xs text-muted mt-0.5 break-all">{c.username}</div>}
										<div className="text-2xs text-muted-soft mt-0.5">
											{c.hasPassword ? "password stored" : "no password stored"}
											{c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleString()}` : ""}
										</div>
									</div>
									<div className="flex gap-1.5 flex-wrap">
										{c.hasPassword && !secret && <Button size="sm" disabled={busy} onClick={() => void reveal(c)}>Reveal</Button>}
										<Button size="sm" disabled={busy} onClick={() => setDraft({ id: c.id, domain: c.domain, loginUrl: c.loginUrl ?? "", username: c.username ?? "", password: "", comments: c.comments ?? "" })}>Edit</Button>
										<Button size="sm" variant="danger" disabled={busy} onClick={() => remove(c)}>Delete</Button>
									</div>
								</div>
								{secret && (
									<div className="mt-2 flex items-center gap-2 flex-wrap" data-testid="credential-revealed">
										<code className="text-sm bg-paper border border-line rounded px-2 py-1 break-all select-all">{secret.password ?? "(no password)"}</code>
										{secret.password && <Button size="sm" onClick={() => void copy(c.id, secret.password as string)}>{copied === c.id ? "Copied" : "Copy"}</Button>}
										<Button size="sm" onClick={() => setRevealed(({ [c.id]: _, ...rest }) => rest)}>Hide</Button>
										<span className="text-2xs text-muted-soft w-full">This reveal is recorded in the agent's trace.</span>
									</div>
								)}
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
