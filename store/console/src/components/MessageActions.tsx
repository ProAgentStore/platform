import { useEffect, useRef, useState } from "react";
import { Check, Copy, Flag, MoreVertical, Trash2 } from "lucide-react";
import DeleteTurnButton from "./DeleteTurnButton";
import { FeedbackButton, FeedbackComposer } from "./FeedbackButton";
import { deleteTurnPrompt, turnEffectSummary, STOP_RUN_PROMPT } from "../lib/turnEffects";
import { deleteTurnRequest } from "../lib/deleteTurn";
import type { Message } from "../lib/types";

/**
 * The controls in a message bubble's corner (#514) — and the reason there are now two layouts.
 *
 * ## The measurement that forced this
 *
 * Copy and Delete sat at `right-1.5` and `right-8`, permanently visible below `sm` because there
 * is no hover on a touch screen, with `pr-12` reserving the 44px they occupy so they could not
 * cover the timestamp (#426). A THIRD icon needs `right-14` and 68px reserved — `pr-20` — and
 * that was measured, not estimated: with `pr-20` the everyday current-year stamp wraps to two
 * lines at 320px in WebKit (`headerH` 32px, guard in e2e/console.spec.ts). #426 explicitly bought
 * the conditional year so that row would NOT wrap; spending it again on a third icon undoes a
 * fix rather than adding a feature.
 *
 * So below `sm` the three collapse into ONE overflow button in the same corner, reserving the
 * same 44px `pr-12` already reserved — and the actions become labelled rows in a sheet, which is
 * strictly better for the two properties the previous tickets bought:
 *
 *   – #389 (44px targets): a 44px-tall full-width row beats a 24px icon.
 *   – #342 (Delete must not be swallowed by a wider neighbour, because a later-painted overlay
 *     wins the hit test): in a vertical sheet nothing overlaps anything, and the destructive
 *     action is the last row and the only one that is red.
 *
 * From `sm` up nothing changes: three hover-revealed icons, same geometry, no reservation.
 *
 * ## Why both layouts are in the DOM
 *
 * `hidden sm:contents` / `sm:hidden` rather than a media-query hook: the console has no
 * `useMediaQuery`, and a JS breakpoint would render the wrong cluster for one paint on every
 * load. The cost is that a geometry guard must ignore zero-sized elements instead of trusting
 * that everything it finds is on screen — every action control therefore carries
 * `data-msg-action`, and the guard filters on measured size.
 */
export default function MessageActions({
	instanceId,
	message,
	messages,
	index,
	agentSlug,
	runActive,
	onStopRun,
	onDeleted,
}: {
	instanceId: string;
	message: Message;
	messages: Message[];
	index: number;
	agentSlug?: string;
	runActive?: boolean;
	onStopRun?: () => void;
	onDeleted: (ids: string[]) => void;
}) {
	return (
		<>
			{/* ≥ sm — unchanged: three hover-revealed icons, `pr-0` on the header. */}
			<span className="hidden sm:contents">
				<CopyButton text={message.content} />
				<DeleteTurnButton
					instanceId={instanceId}
					message={message}
					messages={messages}
					runActive={runActive}
					onStopRun={onStopRun}
					onDeleted={onDeleted}
				/>
				<FeedbackButton instanceId={instanceId} messages={messages} index={index} agentSlug={agentSlug} />
			</span>
			{/* < sm — one control in the same corner, opening labelled rows. */}
			<span className="sm:hidden">
				<OverflowMenu
					instanceId={instanceId}
					message={message}
					messages={messages}
					index={index}
					agentSlug={agentSlug}
					runActive={runActive}
					onStopRun={onStopRun}
					onDeleted={onDeleted}
				/>
			</span>
		</>
	);
}

/**
 * Per-message copy button — top-right of a bubble, subtle, 16px, hover-revealed. Shows a green
 * check for 1.5s after copying. Lived in InstanceDetail until #514 gave it a sibling worth
 * composing with.
 */
export function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			data-msg-action="copy"
			onClick={(e) => {
				e.stopPropagation();
				navigator.clipboard
					.writeText(text)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => {});
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			title={copied ? "Copied" : "Copy"}
			aria-label="Copy message"
			// 24×24 clears WCAG 2.5.8; `tap-target` adds 44px of vertical reach on top, which is
			// the axis a thumb misses on a scrolling thread (#389). See DeleteTurnButton for why
			// the expansion is not horizontal.
			className="tap-target absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 p-1 rounded bg-black/40 text-muted hover:text-accent transition-opacity"
		>
			{copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
		</button>
	);
}

const ROW = "w-full flex items-center gap-2.5 px-4 py-3 text-sm text-left";

function OverflowMenu({
	instanceId,
	message,
	messages,
	index,
	agentSlug,
	runActive,
	onStopRun,
	onDeleted,
}: {
	instanceId: string;
	message: Message;
	messages: Message[];
	index: number;
	agentSlug?: string;
	runActive?: boolean;
	onStopRun?: () => void;
	onDeleted: (ids: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [feedback, setFeedback] = useState(false);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

	const copy = () => {
		navigator.clipboard
			.writeText(message.content)
			.then(() => {
				setCopied(true);
				timer.current = setTimeout(() => setOpen(false), 500);
			})
			.catch(() => setOpen(false));
	};

	// The same three steps DeleteTurnButton takes, in a row instead of an icon: confirm with the
	// sentence lib/turnEffects.ts builds, delete the span the SERVER resolved, then offer to stop a
	// run the deletion does not stop. Duplicated here rather than reused because the ICON is what
	// that component is; the decisions it encodes are already pure and shared.
	const remove = async () => {
		if (busy || !message.id) return;
		if (!confirm(deleteTurnPrompt(turnEffectSummary(messages, message.id)))) return;
		setBusy(true);
		try {
			onDeleted(await deleteTurnRequest(instanceId, message.id));
			if (runActive && onStopRun && confirm(STOP_RUN_PROMPT)) onStopRun();
			setOpen(false);
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<button
				type="button"
				data-msg-action="more"
				onClick={(e) => {
					e.stopPropagation();
					setOpen(true);
				}}
				onDoubleClick={(e) => e.stopPropagation()}
				title="Message actions"
				aria-label="Message actions"
				aria-haspopup="menu"
				className="tap-target absolute top-1 right-1.5 p-1 rounded bg-black/40 text-muted transition-opacity"
			>
				<MoreVertical size={16} />
			</button>
			{open && (
				<div className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center">
					{/* The scrim closes it. A button rather than a div so it is reachable by keyboard
					    and named — the same shape the chat menu's scrim already uses. */}
					<button type="button" aria-label="Close message actions" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
					<div role="menu" className="relative bg-panel border border-line rounded-t-2xl w-full max-w-lg pb-[env(safe-area-inset-bottom)]">
						<button type="button" role="menuitem" data-msg-action="copy" onClick={copy} className={`${ROW} text-ink`}>
							{copied ? <Check size={16} className="text-success" /> : <Copy size={16} className="text-muted" />}
							{copied ? "Copied" : "Copy message"}
						</button>
						<button
							type="button"
							role="menuitem"
							data-msg-action="feedback"
							onClick={() => {
								setOpen(false);
								setFeedback(true);
							}}
							className={`${ROW} text-ink border-t border-line`}
						>
							<Flag size={16} className="text-muted" /> Report a problem
						</button>
						{message.id && (
							<button type="button" role="menuitem" data-msg-action="delete" disabled={busy} onClick={() => void remove()} className={`${ROW} text-danger border-t border-line disabled:opacity-50`}>
								<Trash2 size={16} /> Delete this turn
							</button>
						)}
						<button type="button" onClick={() => setOpen(false)} className={`${ROW} justify-center text-muted border-t border-line font-semibold`}>
							Cancel
						</button>
					</div>
				</div>
			)}
			{feedback && (
				<FeedbackComposer
					instanceId={instanceId}
					messages={messages}
					index={index}
					agentSlug={agentSlug}
					onClose={() => setFeedback(false)}
				/>
			)}
		</>
	);
}
