import { type KeyboardEvent, type RefObject, useState, useEffect, useRef } from "react";
import { renderMd, formatDateTime, classifyMessage, toolCallSummary, messageKey as sdkMessageKey } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { resolveComposer, resolveVoiceStatus } from "@proagentstore/sdk/hooks";
import { API, getToken } from "@proagentstore/sdk/client";
import type { LoopPreset } from "./types";
import { Trash2, Copy, Check, Repeat, Square, Mic, MicOff, Volume2, MessageSquare, Headphones, Send, Wrench, Settings, Loader2, Pencil, CircleDot, ArrowDown, X } from "lucide-react";

/** Double-tap a message: replay its SAVED voice recording (voice turns), else speak
 *  the text via TTS. Owner-scoped fetch of the R2 blob. */
async function playMessage(instanceId: string, m: { content: string; audioKey?: string }, speak: (t: string) => void) {
	if (instanceId && m.audioKey) {
		try {
			const res = await fetch(`${API}/v1/instances/${instanceId}/voice-audio/${m.audioKey}`, {
				headers: { Authorization: `Bearer ${getToken() ?? ""}` },
			});
			if (res.ok) {
				const url = URL.createObjectURL(await res.blob());
				const audio = new Audio(url);
				const cleanup = () => URL.revokeObjectURL(url);
				audio.onended = cleanup;
				audio.onerror = cleanup;
				// play() rejection (e.g. autoplay blocked) fires NEITHER onended nor onerror,
				// so revoke here too or the blob URL leaks. Then fall through to TTS.
				try { await audio.play(); return; } catch { cleanup(); }
			}
		} catch { /* fall through to TTS */ }
	}
	speak(m.content);
}

type Voice = ReturnType<typeof import("@proagentstore/sdk/hooks").useVoice>;
type Loop = ReturnType<typeof import("./use-coding-loop").useCodingLoop>;
type Message = { role: string; content: string; time?: string; audioKey?: string };

/**
 * Per-message copy button — top-right of a bubble, subtle, 16px. Always visible on mobile
 * (no hover there); hover-revealed from `sm` up. Shows a green check for 1.5s after copying.
 */
function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}).catch(() => {});
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			title={copied ? "Copied" : "Copy"}
			aria-label="Copy message"
			className="absolute top-1 right-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded bg-black/40 text-muted hover:text-accent transition-opacity"
		>
			{copied ? <Check size={16} className="text-green" /> : <Copy size={16} />}
		</button>
	);
}

/** Co-pilot view: voice + loop controls, the instruction input, and the message thread. */
export default function CopilotView({
	instanceId, voice, loop, chatInput, setChatInput, sendInstruction,
	summaryHistory, summaryBusy, threadRef, loopPresets, onClearChat,
	workMode, onSetWorkMode,
}: {
	instanceId: string;
	voice: Voice;
	loop: Loop;
	chatInput: string;
	setChatInput: (v: string) => void;
	sendInstruction: () => void;
	summaryHistory: Message[];
	summaryBusy: boolean;
	threadRef: RefObject<HTMLDivElement | null>;
	loopPresets: LoopPreset[];
	onClearChat: () => void;
	/** Loop objective source: "direct" (type it) or "issues" (next open GitHub issue). */
	workMode: "direct" | "issues";
	onSetWorkMode: (mode: "direct" | "issues") => void;
}) {
	const [showChatMenu, setShowChatMenu] = useState(false);
	const closeChatMenu = () => setShowChatMenu(false);
	const activateOnKeyboard = (handler: () => void) => (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			handler();
		}
	};
	const messageKey = (m: Message) => `${m.time || ""}:${m.role}:${m.audioKey || ""}:${m.content.slice(0, 80)}`;
	const handleThreadTap = (target: EventTarget | null) => {
		if ((target as HTMLElement | null)?.closest("button, a, summary, input, textarea")) return;
		if (voice.mode === "ptt") voice.toggleTalk();
		else if (voice.mode === "handsfree") voice.cancelSpeak();
	};
	// Show a "scroll to bottom" affordance when the user has scrolled up off the newest
	// message. Updated from the thread's scroll event; jumping to the bottom hides it again.
	const [atBottom, setAtBottom] = useState(true);
	const scrollThreadToBottom = () => {
		const el = threadRef.current;
		if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); }
	};
	// Full-text edit/preview: the input auto-grows, but the Edit button still opens a big
	// dedicated textarea (seeded with the current input) for reviewing/editing a long message;
	// Apply writes it back, Cancel discards.
	const [editOpen, setEditOpen] = useState(false);
	const [editDraft, setEditDraft] = useState("");
	const openEdit = () => { setEditDraft(chatInput); setEditOpen(true); };
	const applyEdit = () => { setChatInput(editDraft); setEditOpen(false); };
	// Auto-grow the input so a long typed message is readable as it grows, instead of truncating
	// to one line (#164). Caps at ~40vh, then scrolls. It used to also grow for the live
	// transcript; speech is not in this box any more (#364), so the draft is the only input.
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `chatInput` is a trigger, not an input — the effect must re-run as the draft changes so the box keeps growing.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [chatInput]);
	// Smart auto-scroll (#132): follow new messages ONLY while the user is at the bottom.
	// Scrolled up → don't yank them down; the jump button is shown instead. (The old
	// unconditional auto-scroll lived in CodingTab and ignored the user's scroll position.)
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on new messages; atBottom is read live.
	useEffect(() => {
		if (atBottom && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
	}, [summaryHistory]);
	// Computed once so the message list reserves bottom padding (pb-16) whenever the floating
	// status pill is visible — otherwise the pill overlaps (and blocks selecting/copying) the
	// last message.
	const voiceStatus = resolveVoiceStatus({
		mode: voice.mode,
		thinking: summaryBusy,
		// From state, not by string-matching a sentinel in the composer — that literal was
		// duplicated here, in the console, and in the SDK's own phase model, and it only worked
		// because the user's words were destroyed to write it (#281).
		transcribing: voice.transcribing,
		talking: voice.talking,
		listening: voice.micOn,
		speaking: voice.speaking,
		muted: voice.muted,
		starting: voice.starting,
	});
	// What the composer shows and whether voice owns it (#364) — the same tested rule the Assistant
	// tab uses. The box holds the TYPED draft; live speech is the pending bubble at the end of the
	// thread below, and a notice is the banner under the input. Voice locks the box only while an
	// utterance is in flight — not for a notice, and not for a FAILED utterance (the user is
	// reading it and may want to type it themselves).
	const composer = resolveComposer({ draft: chatInput, dictation: voice.dictation, notice: voice.notice });
	const voiceBusy = composer.readOnly;
	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Input bar — top, always visible. Compact input, big controls. relative z-10 keeps it
			    above the floating status pill so nothing can intercept a tap on Send (#163). */}
			<div className="relative z-10 flex gap-1.5 px-2 pt-2 pb-1 shrink-0 items-end">
				<div className="flex-1 min-w-0 relative">
					<textarea
						ref={inputRef}
						rows={1}
						value={composer.value}
						onChange={(e) => { if (!composer.readOnly) setChatInput(e.target.value); }}
						// Enter sends; Shift+Enter inserts a newline (standard chat multi-line input).
						onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !voiceBusy) { e.preventDefault(); sendInstruction(); } }}
						aria-label="Co-pilot message"
						placeholder="Talk to Co-Pilot"
						readOnly={composer.readOnly}
						// Green while the mic is open; accent while voice owns the turn. The old
						// accent "you are speaking" state keyed off the notice string, so after #281
						// it fired on a mic ERROR and never on speech (#364).
						className={`w-full resize-none overflow-y-auto max-h-[40vh] bg-panel border rounded-lg px-2.5 py-1.5 text-sm leading-relaxed transition-colors ${composer.readOnly ? "border-accent" : voice.micOn ? "border-green" : "border-line"}`}
					/>
					{voice.micOn && (
						<div className="absolute bottom-0 left-2 right-2 h-1 rounded-full overflow-hidden bg-line/50">
							<div className="h-full bg-green rounded-full transition-all" style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }} />
						</div>
					)}
				</div>
				<button type="button" onClick={openEdit} disabled={voiceBusy} aria-label="Edit full message" title="Edit / preview the full message" className="px-3 py-2 border border-line text-muted hover:border-accent hover:text-accent rounded-lg font-bold disabled:opacity-40 shrink-0">
					<Pencil size={17} />
				</button>
				{/* Send: clickable in listening mode (only disabled while a reply is generating), with
				    an immediate pressed state (active:scale-95) and a spinner while processing so a
				    tap always gives visible feedback (#163). */}
				<button type="button" onClick={sendInstruction} disabled={summaryBusy} aria-label={summaryBusy ? "Sending…" : "Send"} className="px-3 py-2 bg-accent text-white rounded-lg font-bold disabled:opacity-40 shrink-0 active:scale-95 transition-transform">
					{summaryBusy ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
				</button>
			</div>
			{/* Voice notice — a mic error or the wrong-language nudge, and the ONLY thing that
			    surfaces either. It used to be written into the composer's own value, which hid the
			    draft and made the box read-only for the seconds it was up (#364). The live
			    transcript is NOT here: it is the pending bubble at the end of the thread below. */}
			{composer.notice && (
				<output aria-live="polite" className="mx-2 mb-1 block rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-1.5 text-xs text-yellow whitespace-pre-wrap break-words">
					{composer.notice}
				</output>
			)}
			{/* Controls bar — mode selector + actions (matches the Assistant tab). */}
			<div className="flex flex-wrap gap-1.5 px-2 pt-0.5 pb-1.5 shrink-0 items-center">
				{/* Three distinct interaction modes — one segmented control (was four
				    overlapping toggles). Chat · Tap-to-talk · Hands-free. */}
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					{([
						{ id: "text", label: "Chat", icon: <MessageSquare size={15} />, title: "Chat: type and read replies — no voice", on: "border-accent bg-accent text-white" },
						{ id: "ptt", label: "Tap to talk", icon: <Mic size={15} />, title: "Tap to talk: tap the chat to record, tap again to send. Replies are read aloud.", on: "border-accent bg-accent text-white" },
						{ id: "handsfree", label: "Hands-free", icon: <Headphones size={15} />, title: "Hands-free: fully automatic — it listens, detects when you stop, replies aloud, and listens again.", on: "border-green bg-green text-white" },
					] as const).map((m) => (
						<button
							key={m.id}
							type="button"
							aria-pressed={voice.mode === m.id}
							aria-busy={voice.starting && m.id === "handsfree"}
							title={m.title}
							onClick={() => voice.setVoiceMode(m.id)}
							className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${voice.mode === m.id ? m.on : voice.starting && m.id === "handsfree" ? "bg-green/15 text-green" : "text-muted hover:bg-panel-hover hover:text-accent"}`}
						>
							{/* #284: the mic takes a config read + getUserMedia to open, and until this spinner
							    the control looked untouched for that whole window. It clears when listening
							    really begins, so it and the ready-chime agree. */}
							{voice.starting && m.id === "handsfree" ? <Loader2 size={15} className="animate-spin" /> : m.icon}
							<span className="hidden sm:inline">{voice.starting && m.id === "handsfree" ? "Starting…" : m.label}</span>
						</button>
					))}
				</div>
				{/* Mute. It renders on the interaction MODE and on nothing else, it is never disabled,
				    and it never moves behind a disclosure — every other condition is a phase in which
				    the user cannot stop the agent. On a browser with no Web Speech API the voice
				    channel does not exist at all (`ensureControlStt` returns null) and this control is
				    the whole invariant. Read docs/adr/0001-mute-is-always-available.md (M1) before
				    adding a condition here; the guard is checked by
				    store/console/src/pages/mute-touch-invariant.test.ts. */}
				{voice.mode === "handsfree" && (
					<button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute the mic" : "Mute the mic (stay in hands-free)"} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.muted ? "border-red bg-red text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<MicOff size={16} /><span className="text-xs font-semibold hidden sm:inline">{voice.muted ? "Muted" : "Mute"}</span>
					</button>
				)}
				{/* Work-mode: Direct (type each objective) vs Issues (work the GitHub backlog,
				    approve-per-issue). Sits next to the Loop it configures. */}
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					{([
						{ id: "direct", label: "Direct", title: "Direct: you type each Loop objective", Icon: Pencil },
						{ id: "issues", label: "Issues", title: "Issues: the Loop works your GitHub backlog, approving one issue at a time", Icon: CircleDot },
					] as const).map((m) => (
						<button key={m.id} type="button" aria-pressed={workMode === m.id} aria-label={m.label} title={m.title} disabled={loop.loopOn}
							onClick={() => onSetWorkMode(m.id)}
							className={`flex items-center justify-center px-2 py-1.5 transition-colors disabled:opacity-50 ${workMode === m.id ? "bg-accent text-white" : "text-muted hover:bg-panel-hover hover:text-accent"}`}>
							<m.Icon size={14} />
						</button>
					))}
				</div>
				{loop.loopOn ? (
					<button type="button" onClick={loop.stop} title={`Loop ${loop.loopIteration}/${loop.loopMax}`} className="px-1.5 py-1.5 text-sm border border-green bg-green/15 text-green rounded-lg relative">
						<Square size={13} />
						<span className="absolute -top-1 -right-1 text-2xs bg-green text-white rounded-full px-1 font-bold leading-tight">{loop.loopIteration}</span>
					</button>
				) : (
					<button type="button" onClick={() => { const next = !loop.showLoopForm; loop.setShowLoopForm(next); if (next && workMode === "issues" && !loop.proposedIssue) loop.proposeNextIssue(); }} title="Loop" className={`px-1.5 py-1.5 text-sm border rounded-lg ${loop.showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<Repeat size={13} />
					</button>
				)}
					{/* Clear chat is tucked into a Settings menu (was a bare trash icon). */}
					<div className="relative">
						<button
							type="button"
							onClick={() => setShowChatMenu((v) => !v)}
							title="Chat options"
							aria-label="Chat options"
							className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${showChatMenu ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-accent hover:border-accent"}`}
						>
							<Settings size={13} />
						</button>
						{showChatMenu && (
							<>
								<button type="button" className="fixed inset-0 z-10 cursor-default" aria-label="Close chat options" onClick={closeChatMenu}>
									<span className="sr-only">Close chat options</span>
								</button>
								<div className="absolute right-0 top-full mt-1 z-20 bg-panel border border-line rounded-xl shadow-lg py-1 min-w-[10rem]">
									<button
										type="button"
										onClick={() => { setShowChatMenu(false); onClearChat(); }}
										className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red hover:bg-red/10 transition-colors"
									>
										<Trash2 size={13} /> Clear messages
									</button>
								</div>
							</>
						)}
				</div>
			</div>
			{/* Loop form — DIRECT mode: presets + a custom objective. */}
			{loop.showLoopForm && !loop.loopOn && workMode === "direct" && (
				<div className="bg-panel border border-line rounded-xl p-3 mx-2 mb-1 flex flex-col gap-2">
					<div className="flex flex-wrap gap-1.5">
						{loopPresets.map((p) => (
							<button key={p.id} type="button" onClick={() => loop.setLoopObjective(p.objective)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${loop.loopObjective === p.objective ? "border-accent bg-accent-soft text-accent font-bold" : "border-line text-muted hover:border-accent hover:text-accent"}`}>{p.label}</button>
						))}
					</div>
					<textarea
							value={loop.loopObjective}
							onChange={(e) => loop.setLoopObjective(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); loop.start(); } }}
							aria-label="Loop objective"
							placeholder="Or type a custom objective..."
							className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm resize-none"
						rows={2}
					/>
					<div className="flex items-center gap-2 justify-between">
						<label className="text-xs text-muted flex items-center gap-1.5">Max iterations: <input type="number" value={loop.loopMax} onChange={(e) => loop.setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
						<div className="flex gap-1.5">
							<button type="button" onClick={() => loop.setShowLoopForm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
							<button type="button" onClick={loop.start} disabled={!loop.loopObjective.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-40">Start Loop</button>
						</div>
					</div>
				</div>
			)}
			{/* Loop form — ISSUES mode: approve-per-issue against the GitHub backlog. */}
			{loop.showLoopForm && !loop.loopOn && workMode === "issues" && (
				<div className="bg-panel border border-line rounded-xl p-3 mx-2 mb-1 flex flex-col gap-2">
					{loop.issueBusy ? (
						<div className="text-xs text-muted flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Finding the next open issue…</div>
					) : loop.proposedIssue ? (
						<>
							<div className="text-2xs uppercase tracking-wide text-muted-soft">Next issue — approve to work it, or skip</div>
							<div className="flex items-start gap-2">
								<span className="text-xs font-mono text-accent shrink-0 mt-0.5">#{loop.proposedIssue.number}</span>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-semibold break-words">{loop.proposedIssue.title}</div>
									{loop.proposedIssue.body && <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap line-clamp-4">{loop.proposedIssue.body.slice(0, 400)}</div>}
									{loop.proposedIssue.url && <a href={loop.proposedIssue.url} target="_blank" rel="noreferrer" className="text-2xs text-accent hover:underline inline-block mt-0.5">View on GitHub ↗</a>}
								</div>
							</div>
							<div className="flex items-center gap-2 justify-between">
								<label className="text-xs text-muted flex items-center gap-1.5">Max iterations: <input type="number" value={loop.loopMax} onChange={(e) => loop.setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
								<div className="flex gap-1.5">
									<button type="button" onClick={loop.skipProposedIssue} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Skip</button>
									<button type="button" onClick={loop.approveProposedIssue} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Approve &amp; run #{loop.proposedIssue.number}</button>
								</div>
							</div>
						</>
					) : (
						<div className="flex items-center justify-between gap-2">
							<div className="text-xs text-muted">No open issue to work — the backlog looks clear.</div>
							<div className="flex gap-1.5 shrink-0">
								<button type="button" onClick={() => loop.setShowLoopForm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Close</button>
								<button type="button" onClick={loop.proposeNextIssue} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Check again</button>
							</div>
						</div>
					)}
				</div>
			)}
			{/* Messages. In Tap-to-talk a tap here (not on a bubble/button) starts/stops a
			    recording turn; in Hands-free a tap interrupts the agent so you can talk. */}
			<div className="relative flex-1 min-h-0 flex flex-col">
			{/* biome-ignore lint/a11y/useSemanticElements: this scrollable message thread is a tap target in voice modes and cannot be a native button because it contains controls. */}
			<div
				ref={threadRef}
				role="button"
				tabIndex={0}
				aria-label={voice.mode === "ptt" ? "Tap to talk" : voice.mode === "handsfree" ? "Interrupt speech" : "Message thread"}
				onClick={(e) => handleThreadTap(e.target)}
				onKeyDown={activateOnKeyboard(() => handleThreadTap(document.activeElement))}
				onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
				className={`flex-1 overflow-y-auto flex flex-col gap-2 px-2 py-2 chat-scroll transition-shadow ${voiceStatus ? "pb-16" : ""} ${voice.talking ? "ring-2 ring-inset ring-green" : voice.mode === "ptt" ? "cursor-pointer" : ""}`}
			>
				{summaryHistory.map((m, i) => {
					// Shared classification (SDK) — this heuristic was duplicated here and in the
					// console's instance chat, character for character.
					if (classifyMessage(m) === "tool") {
						const summary = toolCallSummary(m.content);
						return (
							<details key={messageKey(m) || sdkMessageKey(m, i)} className="self-start max-w-[90%]">
								<summary className="flex items-center gap-1.5 text-2xs text-muted cursor-pointer select-none py-0.5 px-2">
									<Wrench size={11} className="shrink-0" />
									<span>Used {summary}</span>
								</summary>
								<SafeHtmlView className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-2xs text-muted leading-relaxed msg-md" html={renderMd(m.content)} />
							</details>
						);
					}
					if (classifyMessage(m) === "system") {
						return (
							<div key={messageKey(m)} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15 max-w-[90%]">
								<span className="whitespace-pre-wrap break-words">{m.content}</span>
							</div>
						);
					}
					return (
						/* biome-ignore lint/a11y/useSemanticElements: message bubbles contain nested controls, so a native button would be invalid. */
						<div
							key={messageKey(m)}
							// Keep a bubble tap from bubbling to the thread tap handler (which would
							// churn the mic on a double-tap-to-replay); double-tap still replays.
							role="button"
							tabIndex={0}
							onClick={(e) => e.stopPropagation()}
							onKeyDown={activateOnKeyboard(() => playMessage(instanceId, m, voice.speak))}
							className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-auto select-text ${
								m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
									: "bg-panel border border-line self-start rounded-bl-sm"
							}`}
						>
							<CopyButton text={m.content} />
							{m.role === "user" && <div className="text-2xs opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(instanceId, m, voice.speak); }} onDoubleClick={(e) => e.stopPropagation()} title="Play your recording" className="tap-target min-w-6 inline-flex justify-center opacity-80 hover:opacity-100"><Volume2 size={11} /></button>}</span>{m.time && <span className="font-normal opacity-80">{formatDateTime(m.time)}</span>}</div>}
							{m.role === "assistant" && <div className="text-2xs text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">Co-pilot<button type="button" onClick={(e) => { e.stopPropagation(); playMessage(instanceId, m, voice.speak); }} onDoubleClick={(e) => e.stopPropagation()} title="Play this message" className="tap-target min-w-6 inline-flex justify-center opacity-70 hover:opacity-100"><Volume2 size={11} /></button></span>{m.time && <span className="font-normal text-muted">{formatDateTime(m.time)}</span>}</div>}
							{m.role === "assistant" ? (
								<SafeHtmlView className="msg-md" html={renderMd(m.content)} />
							) : (
								<span className="whitespace-pre-wrap break-words">{m.content}</span>
							)}
						</div>
					);
				})}
				{/* The utterance in flight (#281) — the same bubble the Assistant tab shows. The words
				    used to sit in the composer and be overwritten with "Transcribing…" at end-of-turn, so
				    they vanished for the whole upload round trip. */}
				{voice.dictation && (
					<div
						aria-live="polite"
						className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-auto select-text self-end rounded-br-sm border border-dashed ${
							voice.dictation.status === "failed" ? "bg-red/10 border-red/50 text-red" : "bg-accent/60 border-white/40 text-white"
						}`}
					>
						<div className="text-2xs opacity-90 mb-0.5 font-bold flex items-center justify-between gap-3">
							<span className="flex items-center gap-1">
								You
								{voice.dictation.status === "dictating" && <><Mic size={11} />Speaking…</>}
								{voice.dictation.status === "transcribing" && <><Loader2 size={11} className="animate-spin" />Transcribing…</>}
								{voice.dictation.status === "failed" && <span>Not transcribed</span>}
							</span>
							{voice.dictation.status === "failed" && (
								<span className="flex items-center gap-2">
									{/* Re-send the same clip — see InstanceDetail for why this is offered on a
									    timeout/5xx and withheld on a 400/401 (#421). */}
									{voice.canRetryDictation && (
										<button type="button" onClick={voice.retryDictation} className="font-semibold underline opacity-80 hover:opacity-100">Retry</button>
									)}
									<button type="button" onClick={voice.clearDictation} className="font-semibold underline opacity-80 hover:opacity-100">Dismiss</button>
								</span>
							)}
						</div>
						<span className="whitespace-pre-wrap break-words italic">
							{voice.dictation.text || (voice.dictation.status === "failed" ? "(nothing was captured)" : "…")}
						</span>
						{voice.dictation.status === "failed" && voice.dictation.note && (
							<div className="text-2xs mt-1 opacity-80 not-italic">{voice.dictation.note}</div>
						)}
					</div>
				)}
			</div>
			{/* Scroll-to-latest — appears only when scrolled up off the newest message. */}
			{!atBottom && (
				<button
					type="button"
					onClick={scrollThreadToBottom}
					aria-label="Scroll to latest"
					title="Scroll to latest"
					className="absolute bottom-3 right-3 z-30 flex items-center justify-center w-9 h-9 rounded-full bg-panel border border-line shadow-lg text-muted hover:text-accent hover:border-accent transition-colors"
				>
					<ArrowDown size={16} />
				</button>
			)}
			{/* Live voice status — the OBVIOUS "it heard you / is working" signal. Walks
			    Listening → Transcribing → Working, and is the tap target in Tap-to-talk. */}
			{(() => {
				const s = voiceStatus;
				if (!s) return null;
				const cls = s.tone === "work" ? "bg-accent text-white ring-4 ring-accent/25 animate-pulse"
					: s.tone === "speak" ? "bg-accent text-white ring-4 ring-accent/25"
					: s.tone === "live" ? "bg-green text-white ring-4 ring-green/30 animate-pulse scale-105"
					: "bg-panel border border-line text-muted hover:text-accent hover:border-accent";
				const StatusIcon = s.icon === "spin" ? Loader2 : s.icon === "speak" ? Volume2 : Mic;
				return (
					<div className="absolute left-0 right-0 bottom-3 flex justify-center px-4 pointer-events-none z-20">
						<button type="button" onClick={s.tap ? (s.tone === "speak" ? voice.cancelSpeak : voice.toggleTalk) : undefined} disabled={!s.tap} aria-live="polite" className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm shadow-lg transition-all ${cls} ${s.tap ? "cursor-pointer" : "cursor-default"}`}>
							<StatusIcon size={16} className={s.icon === "spin" ? "animate-spin" : ""} />
							{s.label}
						</button>
					</div>
				);
			})()}
			</div>
			{/* Full-text edit/preview modal — a large textarea to review + edit the whole message
			    before sending. Apply writes it back to the input; Cancel (or backdrop) discards. */}
			{editOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
					<button type="button" aria-label="Close editor" className="absolute inset-0 bg-black/60 cursor-default" onClick={() => setEditOpen(false)}>
						<span className="sr-only">Close editor</span>
					</button>
					<div role="dialog" aria-modal="true" aria-label="Edit message" className="relative w-full max-w-3xl h-[80vh] flex flex-col bg-panel border border-line rounded-xl shadow-2xl overflow-hidden">
						<div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
							<span className="font-bold text-sm">Edit message</span>
							<button type="button" onClick={() => setEditOpen(false)} aria-label="Close" className="text-muted hover:text-accent">
								<X size={18} />
							</button>
						</div>
						<textarea
							value={editDraft}
							onChange={(e) => setEditDraft(e.target.value)}
							aria-label="Edit message text"
							placeholder="Review and edit your full message…"
							className="flex-1 w-full resize-none bg-paper text-sm px-4 py-3 outline-none leading-relaxed"
						/>
						<div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line shrink-0">
							<button type="button" onClick={() => setEditOpen(false)} className="px-4 py-2 rounded-lg border border-line text-muted font-semibold text-sm hover:border-accent hover:text-accent active:scale-95 transition-transform">
								Cancel
							</button>
							<button type="button" onClick={applyEdit} className="px-4 py-2 rounded-lg bg-accent text-white font-bold text-sm active:scale-95 transition-transform">
								Apply
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
