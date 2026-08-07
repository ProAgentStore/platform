import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { AlertCircle, Loader2 } from "lucide-react";
import Button from "./Button";
import {
	answerPayload,
	closedNote,
	controlFor,
	initialDraft,
	labelFor,
	missingRequired,
	optionLabel,
	pendingOnly,
	timeLeft,
	type McpInputDraft,
	type McpInputField,
	type McpInputRequest,
} from "../lib/mcpInputRequests";

/**
 * The remote server is asking you something (#264).
 *
 * WHY THIS IS IN THE CHAT AND NOT IN SETTINGS. The pause happens mid-conversation: the agent has
 * just said it is waiting on you, and the answer belongs where that sentence is. A form buried in
 * a settings tab is a form nobody finds inside the 30-minute window, and a request that times out
 * unseen is the same outcome as not having built any of this.
 *
 * WHAT IS RENDERED, AND WHAT IS NOT. The message and the field labels come from a REMOTE server, so
 * they are rendered as TEXT — no markdown, no HTML, no link — for the same reason `mcp_read_resource`
 * fences what it returns. A server that can put clickable markup on this page can phish the person
 * who is already being asked for a password by it.
 *
 * The values are never echoed back. A `sensitive` field gets a masked box, nothing is pre-filled,
 * and once submitted the card disappears rather than showing what was sent — the answer exists on
 * the wire and in the remote server, and this console is deliberately not a third copy.
 *
 * Every decision (control kind, draft shape, what is missing, how long is left) lives in
 * lib/mcpInputRequests.ts with its tests. This renders.
 */
export default function McpInputRequests({ instanceId }: { instanceId: string }) {
	const [requests, setRequests] = useState<McpInputRequest[]>([]);
	const [drafts, setDrafts] = useState<Record<string, McpInputDraft>>({});
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [note, setNote] = useState("");

	const load = useCallback(async () => {
		try {
			const res = await api<{ requests: McpInputRequest[] }>(`/v1/instances/${instanceId}/mcp/input-requests`);
			const pending = pendingOnly(res.requests ?? []);
			setRequests(pending);
			// Drafts are keyed by request id and REBUILT only for asks we have not seen, so a poll
			// landing while someone is halfway through typing does not wipe the box they are in.
			setDrafts((prev) => {
				const next: Record<string, McpInputDraft> = {};
				for (const r of pending) next[r.id] = prev[r.id] ?? initialDraft(r.fields);
				return next;
			});
		} catch {
			// A failed poll is not worth a banner: the panel simply shows nothing, and the agent's own
			// "I am waiting on you" message is still in the thread above it.
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
		// 20s: an ask arrives while the person is reading the reply that announced it, and the
		// deadline is 30 minutes, so this is about noticing it rather than about latency.
		const t = setInterval(() => void load(), 20_000);
		return () => clearInterval(t);
	}, [load]);

	const respond = async (req: McpInputRequest, action: "submit" | "cancel") => {
		setBusy(req.id);
		setError("");
		setNote("");
		try {
			const res = await api<{ ok?: boolean; status?: string; content?: string; detail?: string }>(`/v1/instances/${instanceId}/mcp/input-requests/${req.id}`, {
				method: "POST",
				body: JSON.stringify(action === "cancel" ? { action: "cancel" } : { action: "submit", values: answerPayload(req.fields, drafts[req.id] ?? {}) }),
			});
			setNote(action === "cancel" ? (res.detail ?? "Cancelled.") : res.ok ? "Sent — the agent has the result." : "The server was answered, but the call did not succeed. Check the agent's reply.");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not send that answer.");
		} finally {
			setBusy("");
			// Reload whatever the outcome: a failed submit may have been a claim someone else won, and
			// the honest thing to show then is that the ask is gone.
			await load();
		}
	};

	if (!requests.length) return note || error ? <p className={`text-xs px-3 py-2 ${error ? "text-red" : "text-muted"}`}>{error || note}</p> : null;

	return (
		<div className="flex flex-col gap-2 px-2 pt-2">
			{requests.map((req) => {
				const draft = drafts[req.id] ?? {};
				const missing = missingRequired(req.fields, draft);
				const left = timeLeft(req.expiresAt);
				return (
					<div key={req.id} className="border border-yellow/60 bg-panel rounded-xl p-3 text-sm">
						<div className="flex items-start gap-2 mb-2">
							<AlertCircle size={15} className="text-yellow shrink-0 mt-0.5" />
							<div className="min-w-0">
								<p className="font-semibold">{req.tool} needs something from you</p>
								<p className="text-[0.7rem] text-muted break-all">
									{req.endpoint}
									{req.round > 1 && ` · round ${req.round} of ${req.maxRounds}`}
									{left ? ` · ${left}` : ` · ${closedNote("expired")}`}
								</p>
							</div>
						</div>
						{/* Remote text, rendered as text. See the note at the top of this file. */}
						<p className="text-sm mb-3 whitespace-pre-wrap break-words">{req.message}</p>

						<div className="flex flex-col gap-2">
							{req.fields.map((field) => (
								<Field
									key={field.name}
									// Scoped by request id: two servers may both ask for `account`, and a bare
									// field name would give the second form's box the first one's label.
									id={`mcp-input-${req.id}-${field.name}`}
									field={field}
									value={draft[field.name]}
									onChange={(v) => setDrafts((prev) => ({ ...prev, [req.id]: { ...(prev[req.id] ?? {}), [field.name]: v } }))}
								/>
							))}
						</div>

						{/* Said BEFORE the button, not after the click: the resume re-sends the whole call,
						    which is the one thing about this design a person could be surprised by. */}
						<p className="text-[0.7rem] text-muted mt-3">
							Answering re-sends the whole call to that server with your answer added. Cancelling sends nothing.
						</p>
						{missing.length > 0 && <p className="text-[0.7rem] text-yellow mt-1">Still needed: {missing.join(", ")}</p>}
						{error && <p className="text-[0.7rem] text-red mt-1">{error}</p>}
						<div className="flex gap-2 mt-2">
							<Button variant="primary" disabled={busy === req.id || missing.length > 0} onClick={() => void respond(req, "submit")}>
								{busy === req.id && <Loader2 size={12} className="animate-spin" />}
								Send answer
							</Button>
							<Button disabled={busy === req.id} onClick={() => void respond(req, "cancel")}>
								Cancel
							</Button>
						</div>
					</div>
				);
			})}
			{note && <p className="text-xs text-muted px-1">{note}</p>}
		</div>
	);
}

/** One control. `controlFor` decides which — this only draws it. */
function Field({ id, field, value, onChange }: { id: string; field: McpInputField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
	const control = controlFor(field);
	const inputClass = "w-full bg-paper border border-line rounded-lg px-2 py-1.5 text-sm focus:border-accent outline-none";
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={id} className="text-[0.7rem] font-semibold text-muted">
				{labelFor(field)}
				{field.required && <span className="text-yellow"> *</span>}
			</label>
			{field.description && <span className="text-[0.7rem] text-muted">{field.description}</span>}
			{control === "checkbox" ? (
				<input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-accent self-start" />
			) : control === "select" ? (
				<select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputClass}>
					<option value="">Choose…</option>
					{(field.options ?? []).map((opt, i) => (
						<option key={opt} value={opt}>
							{optionLabel(field, i)}
						</option>
					))}
				</select>
			) : (
				<input
					id={id}
					// A masked box for anything the server named like a secret, and `autoComplete="off"`
					// on every field: this form's values are one-shot answers to a remote question, not
					// account details a browser should remember and re-offer on the next one.
					type={control === "password" ? "password" : control === "number" ? "number" : "text"}
					value={String(value ?? "")}
					autoComplete="off"
					onChange={(e) => onChange(e.target.value)}
					className={inputClass}
				/>
			)}
		</div>
	);
}
