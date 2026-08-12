import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import { buildCapture, previewOf } from "../lib/feedback";
import type { Message } from "../lib/types";

/**
 * "This is wrong" — on the message it is about (#514).
 *
 * NO MODEL IS IN THIS PATH. That is the point of it existing at all: the turn on which an agent
 * is malfunctioning is the turn least able to correctly call a tool about its own malfunction.
 * #504's Pilot emitted 11 empty `tool_use` blocks out of 19; #503's agent could not report that
 * its own tool results were being truncated. A capture path that runs inside the failing turn is
 * absent exactly when it matters, so this one is a plain POST.
 *
 * The agent's `record_feedback` tool exists too, for "that's wrong, write that down" said out
 * loud mid-conversation. It writes the same row shape with `author:'agent'`. Neither replaces
 * the other; this is the one that cannot fail for the reason being reported.
 *
 * The composer holds the words. A bare thumbs-down is not filable evidence — the sentiment chips
 * are a shortcut INTO the composer, never a silent submit.
 */
export function FeedbackButton({
	instanceId,
	messages,
	index,
	agentSlug,
}: {
	instanceId: string;
	messages: Message[];
	index: number;
	agentSlug?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				data-msg-action="feedback"
				onClick={(e) => {
					e.stopPropagation();
					setOpen(true);
				}}
				onDoubleClick={(e) => e.stopPropagation()}
				title="Report a problem with this message"
				aria-label="Report a problem with this message"
				// Third in the corner cluster, and the reservation the header rows make for it is
				// measured rather than guessed — see the block comment on the stamp in
				// InstanceDetail.tsx and the WebKit geometry guard in e2e/console.spec.ts.
				className="tap-target absolute top-1 right-14 opacity-0 group-hover:opacity-100 p-1 rounded bg-black/40 text-muted hover:text-accent transition-opacity"
			>
				<Flag size={16} />
			</button>
			{open && (
				<FeedbackComposer
					instanceId={instanceId}
					messages={messages}
					index={index}
					agentSlug={agentSlug}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

export function FeedbackComposer({
	instanceId,
	messages,
	index,
	agentSlug,
	onClose,
}: {
	instanceId: string;
	messages: Message[];
	index: number;
	agentSlug?: string;
	onClose: () => void;
}) {
	const [body, setBody] = useState("");
	const [sentiment, setSentiment] = useState<"bad" | "good" | undefined>("bad");
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const target = messages[index];

	const submit = async () => {
		if (!body.trim() || saving) return;
		setSaving(true);
		setErr(null);
		try {
			await api("/v1/feedback", {
				method: "POST",
				body: JSON.stringify(buildCapture({ instanceId, messages, index, body, agentSlug, sentiment })),
			});
			setDone(true);
			setTimeout(onClose, 900);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Could not save that");
			setSaving(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<div className="bg-panel border border-line rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto overscroll-contain p-4" style={{ WebkitOverflowScrolling: "touch" }}>
				<div className="flex items-center justify-between gap-3 mb-1">
					<h3 className="text-base font-bold flex items-center gap-1.5">
						<Flag size={16} /> What went wrong?
					</h3>
					<button type="button" onClick={onClose} aria-label="Close feedback" className="text-muted hover:text-ink text-lg leading-none">
						✕
					</button>
				</div>
				<p className="text-xs text-muted mb-3">
					Kept with this turn so it can be read back with the conversation. It is not sent to the agent and does not
					change how it behaves.
				</p>
				{target?.content && (
					<div className="text-2xs text-muted bg-paper border border-line rounded-lg px-2.5 py-2 mb-3">
						<span className="font-bold uppercase tracking-wide">{target.role === "user" ? "Your message" : "The agent said"}</span>
						<div className="mt-0.5 leading-relaxed">{previewOf(target.content, 220)}</div>
					</div>
				)}
				<div className="flex items-center gap-1.5 mb-2">
					{(["bad", "good"] as const).map((s) => (
						<Button key={s} variant={sentiment === s ? "primary" : "secondary"} onClick={() => setSentiment(sentiment === s ? undefined : s)}>
							{s === "bad" ? "Got it wrong" : "Got it right"}
						</Button>
					))}
				</div>
				<textarea
					value={body}
					onChange={(e) => setBody(e.target.value)}
					// Dictation is the composer's, not a voice command: "that's wrong" is ordinary
					// speech and a command word matching it would turn half a conversation into rows.
					placeholder="It said the tests passed, but it never ran them."
					aria-label="What went wrong"
					rows={4}
					maxLength={4000}
					className="w-full bg-paper border border-line rounded-lg px-2.5 py-2 text-sm"
				/>
				{err && <div className="mt-2 text-xs px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-danger">{err}</div>}
				<div className="flex items-center justify-end gap-2 mt-3">
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" onClick={() => void submit()} disabled={!body.trim() || saving || done}>
						{saving && <Loader2 size={13} className="animate-spin" />}
						{done ? "Saved" : "Save feedback"}
					</Button>
				</div>
			</div>
		</div>
	);
}
