import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { useConversation, useConversationSwitch } from "../lib/ConversationContext";
import { resolveConversationIndicator, resolveParkedIndicator, type ConversationSnapshot, type IndicatorView } from "../lib/conversation";

/**
 * The persistent "you are in a conversation with X" indicator (#278) — and, beside it, the agent
 * you left still working (#450).
 *
 * Lives in the top bar so it survives every route change, which is the whole point: while
 * hands-free, the only way back to an agent was to remember which of a dozen it was and navigate
 * the instance list. What each pill shows is decided by a pure, tested function
 * (`resolveConversationIndicator` / `resolveParkedIndicator`) — so neither can drift into claiming
 * a microphone is open when it is not.
 *
 * Clicking returns to the agent AND resumes the voice mode you were in. That is deliberate and it
 * is why these are buttons rather than links: the click is a user gesture, the one thing iOS
 * requires to reopen a mic and prime speech, so returning by hand restores hands-free properly
 * where a bare navigation could not.
 *
 * Icon-only below `sm`: this is the screen where the indicator matters most and where the header
 * has the least room — the instance tabs there are already icon-only for the same reason. Two
 * pills is the ceiling, and on an instance page it is never reached: the current conversation
 * suppresses itself on its own route, so what is beside the bell there is the parked one alone.
 */
function Pill({ view, snapshot, onDismiss, dismissLabel }: { view: IndicatorView; snapshot: ConversationSnapshot; onDismiss: () => void; dismissLabel: string }) {
	const { switchTo } = useConversationSwitch();
	const working = view.tone === "work";
	return (
		<span className="flex items-center shrink-0 min-w-0">
			<button
				type="button"
				title={view.title}
				aria-label={view.title}
				onClick={() => switchTo({ instanceId: snapshot.instanceId, name: snapshot.name }, { mode: view.resumeMode, announce: false })}
				className={`flex items-center gap-1.5 max-w-40 min-w-0 pl-1 pr-1.5 py-0.5 rounded-full border transition-colors ${
					working ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-muted hover:text-ink hover:border-accent"
				}`}
			>
				<span
					className="w-5 h-5 rounded-full flex items-center justify-center text-2xs shrink-0"
					style={{ background: snapshot.bg }}
					aria-hidden="true"
				>
					{snapshot.emoji}
				</span>
				<span className="hidden sm:inline text-xs font-semibold truncate">{view.label}</span>
				{/* The state dot carries the meaning on mobile, where the label is hidden: pulsing
				    accent = still working, plain = parked with the mic closed. */}
				<span
					aria-hidden="true"
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${working ? "bg-accent animate-pulse" : "bg-muted"}`}
				/>
			</button>
			<button
				type="button"
				onClick={onDismiss}
				title="Dismiss"
				aria-label={dismissLabel}
				className="text-muted hover:text-ink shrink-0 -ml-0.5 p-0.5"
			>
				<X size={12} />
			</button>
		</span>
	);
}

export default function ConversationPill() {
	const { conversation, parked, clearConversation, dismissParked } = useConversation();
	const { pathname } = useLocation();
	const view = resolveConversationIndicator(conversation, pathname);
	const parkedView = resolveParkedIndicator(parked, pathname);
	if (!view && !parkedView) return null;
	return (
		// The agent you LEFT running sits first, and the conversation you are in sits nearest the
		// bell: the current one is the one that keeps its position as the other appears and goes.
		<span className="flex items-center gap-1.5 shrink-0 min-w-0">
			{parkedView && parked && (
				<Pill view={parkedView} snapshot={parked} onDismiss={dismissParked} dismissLabel={`Dismiss the ${parked.name} indicator`} />
			)}
			{view && conversation && (
				<Pill view={view} snapshot={conversation} onDismiss={clearConversation} dismissLabel="Dismiss conversation indicator" />
			)}
		</span>
	);
}
