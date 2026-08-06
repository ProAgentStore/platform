import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { useConversation, useConversationSwitch } from "../lib/ConversationContext";
import { resolveConversationIndicator } from "../lib/conversation";

/**
 * The persistent "you are in a conversation with X" indicator (#278).
 *
 * Lives in the top bar so it survives every route change, which is the whole point: while
 * hands-free, the only way back to an agent was to remember which of a dozen it was and navigate
 * the instance list. What it shows is decided by `resolveConversationIndicator` — pure and tested
 * — so the pill cannot drift into claiming a microphone is open when it is not.
 *
 * Clicking returns to the agent AND resumes the voice mode you were in. That is deliberate and it
 * is why this is a button rather than a link: the click is a user gesture, the one thing iOS
 * requires to reopen a mic and prime speech, so returning by hand restores hands-free properly
 * where a bare navigation could not.
 *
 * Icon-only below `sm`: this is the screen where the indicator matters most and where the header
 * has the least room — the instance tabs there are already icon-only for the same reason.
 */
export default function ConversationPill() {
	const { conversation, clearConversation } = useConversation();
	const { switchTo } = useConversationSwitch();
	const { pathname } = useLocation();
	const view = resolveConversationIndicator(conversation, pathname);
	if (!view || !conversation) return null;

	const working = view.tone === "work";
	return (
		<span className="flex items-center shrink-0 min-w-0">
			<button
				type="button"
				title={view.title}
				aria-label={view.title}
				onClick={() => switchTo({ instanceId: conversation.instanceId, name: conversation.name }, { mode: view.resumeMode, announce: false })}
				className={`flex items-center gap-1.5 max-w-40 min-w-0 pl-1 pr-1.5 py-0.5 rounded-full border transition-colors ${
					working ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-muted hover:text-ink hover:border-accent"
				}`}
			>
				<span
					className="w-5 h-5 rounded-full flex items-center justify-center text-[0.7rem] shrink-0"
					style={{ background: conversation.bg }}
					aria-hidden="true"
				>
					{conversation.emoji}
				</span>
				<span className="hidden sm:inline text-[0.72rem] font-semibold truncate">{view.label}</span>
				{/* The state dot carries the meaning on mobile, where the label is hidden: pulsing
				    accent = still working, plain = parked with the mic closed. */}
				<span
					aria-hidden="true"
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${working ? "bg-accent animate-pulse" : "bg-muted"}`}
				/>
			</button>
			<button
				type="button"
				onClick={clearConversation}
				title="Dismiss"
				aria-label="Dismiss conversation indicator"
				className="text-muted hover:text-ink shrink-0 -ml-0.5 p-0.5"
			>
				<X size={12} />
			</button>
		</span>
	);
}
