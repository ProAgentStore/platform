import { type RefObject, useState } from "react";
import { renderMd, formatDateTime } from "@proagentstore/sdk/ui";
import { resolveVoiceStatus } from "@proagentstore/sdk/hooks";
import { API, getToken } from "@proagentstore/sdk/client";
import { Trash2, Copy, Repeat, Square, Mic, MicOff, Volume2, MessageSquare, Headphones, Send, Wrench, Eye, Settings, Loader2 } from "lucide-react";

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
type LoopPreset = { id: string; label: string; objective: string };

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
	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Input bar — top, always visible. Compact input, big controls. */}
			<div className="flex gap-1.5 px-2 pt-2 pb-1 shrink-0 items-center">
				<div className="flex-1 min-w-0 relative">
					<input
						value={voice.interim || chatInput}
						onChange={(e) => { if (!voice.interim) setChatInput(e.target.value); }}
						onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendInstruction(); }}
						placeholder={voice.mode === "handsfree" ? "Hands-free — just talk" : voice.mode === "ptt" ? "Tap the chat to talk" : "Ask or tell the agent…"}
						readOnly={!!voice.interim}
						className={`w-full bg-panel border rounded-lg px-2.5 py-1.5 text-sm transition-colors ${voice.interim ? "border-accent text-accent font-semibold" : voice.micOn ? "border-green" : "border-line"}`}
					/>
					{voice.micOn && (
						<div className="absolute bottom-0 left-2 right-2 h-1 rounded-full overflow-hidden bg-line/50">
							<div className="h-full bg-green rounded-full transition-all" style={{ width: `${Math.round(voice.audioLevel * 100)}%`, transitionDuration: "50ms" }} />
						</div>
					)}
				</div>
				<button type="button" onClick={sendInstruction} disabled={!!voice.interim} aria-label="Send" className="px-3 py-2 bg-accent text-white rounded-lg font-bold disabled:opacity-40 shrink-0">
					<Send size={17} />
				</button>
			</div>
			{/* Live transcript — show the user exactly what's being heard. */}
			{voice.interim && (
				<div className="px-3 py-1.5 shrink-0 text-sm text-accent font-semibold border-b border-line bg-accent-soft/40 truncate">🎙 {voice.interim}</div>
			)}
			{/* Controls bar — mode selector + actions (matches the Assistant tab). */}
			<div className="flex flex-wrap gap-1.5 px-2 pt-0.5 pb-1.5 shrink-0 items-center">
				{/* Three distinct interaction modes — one segmented control (was four
				    overlapping toggles). Chat · Tap-to-talk · Hands-free. */}
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0" role="radiogroup" aria-label="Interaction mode">
					{([
						{ id: "text", label: "Chat", icon: <MessageSquare size={15} />, title: "Chat: type and read replies — no voice", on: "border-accent bg-accent text-white" },
						{ id: "ptt", label: "Tap to talk", icon: <Mic size={15} />, title: "Tap to talk: tap the chat to record, tap again to send. Replies are read aloud.", on: "border-accent bg-accent text-white" },
						{ id: "handsfree", label: "Hands-free", icon: <Headphones size={15} />, title: "Hands-free: fully automatic — it listens, detects when you stop, replies aloud, and listens again.", on: "border-green bg-green text-white" },
					] as const).map((m) => (
						<button
							key={m.id}
							type="button"
							role="radio"
							aria-checked={voice.mode === m.id}
							title={m.title}
							onClick={() => voice.setVoiceMode(m.id)}
							className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${voice.mode === m.id ? m.on : "text-muted hover:bg-panel-hover hover:text-accent"}`}
						>
							{m.icon}<span className="hidden sm:inline">{m.label}</span>
						</button>
					))}
				</div>
				{voice.mode === "handsfree" && (
					<button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute the mic" : "Mute the mic (stay in hands-free)"} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${voice.muted ? "border-red bg-red text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<MicOff size={16} /><span className="text-xs font-semibold hidden sm:inline">{voice.muted ? "Muted" : "Mute"}</span>
					</button>
				)}
				{/* Work-mode: Direct (type each objective) vs Issues (work the GitHub backlog,
				    approve-per-issue). Sits next to the Loop it configures. */}
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0" role="radiogroup" aria-label="Loop work mode">
					{([
						{ id: "direct", label: "Direct", title: "Direct: you type each Loop objective" },
						{ id: "issues", label: "Issues", title: "Issues: the Loop works your GitHub backlog, approving one issue at a time" },
					] as const).map((m) => (
						<button key={m.id} type="button" role="radio" aria-checked={workMode === m.id} title={m.title} disabled={loop.loopOn}
							onClick={() => onSetWorkMode(m.id)}
							className={`px-2 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${workMode === m.id ? "bg-accent text-white" : "text-muted hover:bg-panel-hover hover:text-accent"}`}>
							{m.label}
						</button>
					))}
				</div>
				{loop.loopOn ? (
					<button type="button" onClick={loop.stop} title={`Loop ${loop.loopIteration}/${loop.loopMax}`} className="px-1.5 py-1.5 text-sm border border-green bg-green/15 text-green rounded-lg relative">
						<Square size={13} />
						<span className="absolute -top-1 -right-1 text-[0.55rem] bg-green text-white rounded-full px-1 font-bold leading-tight">{loop.loopIteration}</span>
					</button>
				) : (
					<button type="button" onClick={() => { const next = !loop.showLoopForm; loop.setShowLoopForm(next); if (next && workMode === "issues" && !loop.proposedIssue) loop.proposeNextIssue(); }} title="Loop" className={`px-1.5 py-1.5 text-sm border rounded-lg ${loop.showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<Repeat size={13} />
					</button>
				)}
				{/* Clear chat is tucked into a Settings menu (was a bare trash icon). */}
				<div className="relative">
					<button type="button" onClick={() => setShowChatMenu((v) => !v)} title="Chat options" aria-label="Chat options" className={`px-1.5 py-1.5 text-sm border rounded-lg transition-colors ${showChatMenu ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-accent hover:border-accent"}`}><Settings size={13} /></button>
					{showChatMenu && (
						<>
							<div className="fixed inset-0 z-10" onClick={() => setShowChatMenu(false)} />
							<div className="absolute right-0 top-full mt-1 z-20 bg-panel border border-line rounded-xl shadow-lg py-1 min-w-[10rem]">
								<button type="button" onClick={() => { setShowChatMenu(false); onClearChat(); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red hover:bg-red/10 transition-colors"><Trash2 size={13} /> Clear messages</button>
							</div>
						</>
					)}
				</div>
			</div>
			{/* Scope hint — this is NOT the general Assistant chat; it's tied to THIS session. */}
			<div className="px-3 pb-1.5 shrink-0 text-[0.7rem] text-muted-soft flex items-center gap-1">
				<Eye size={11} className="shrink-0" /> Co-pilot — watching this coding session
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
							<div className="text-[0.7rem] uppercase tracking-wide text-muted-soft">Next issue — approve to work it, or skip</div>
							<div className="flex items-start gap-2">
								<span className="text-xs font-mono text-accent shrink-0 mt-0.5">#{loop.proposedIssue.number}</span>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-semibold break-words">{loop.proposedIssue.title}</div>
									{loop.proposedIssue.body && <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap line-clamp-4">{loop.proposedIssue.body.slice(0, 400)}</div>}
									{loop.proposedIssue.url && <a href={loop.proposedIssue.url} target="_blank" rel="noreferrer" className="text-[0.7rem] text-accent hover:underline inline-block mt-0.5">View on GitHub ↗</a>}
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
			<div
				ref={threadRef}
				onClick={(e) => {
					if ((e.target as HTMLElement).closest("button, a, summary, input, textarea")) return;
					if (voice.mode === "ptt") voice.toggleTalk();
					else if (voice.mode === "handsfree") voice.cancelSpeak();
				}}
				className={`flex-1 overflow-y-auto flex flex-col gap-2 px-2 py-2 chat-scroll transition-shadow ${voice.talking ? "ring-2 ring-inset ring-green" : voice.mode === "ptt" ? "cursor-pointer" : ""}`}
			>
				{summaryHistory.map((m, i) => {
					// Tool calls: collapsed chip
					const isToolCall = m.role === "system" && /^[✅❌]/.test(m.content);
					if (isToolCall) {
						const toolNames = m.content.match(/\*\*(\w+)\*\*/g)?.map((t) => t.replace(/\*\*/g, "")) || ["tools"];
						const summary = toolNames.length <= 2 ? toolNames.join(", ") : `${toolNames.length} tools`;
						return (
							<details key={i} className="self-start max-w-[90%]">
								<summary className="flex items-center gap-1.5 text-[0.7rem] text-muted cursor-pointer select-none py-0.5 px-2">
									<Wrench size={11} className="shrink-0" />
									<span>Used {summary}</span>
								</summary>
								<div className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-[0.7rem] text-muted leading-relaxed msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
							</details>
						);
					}
					if (m.role === "system") {
						return (
							<div key={i} className="bg-yellow/10 text-yellow self-center rounded-full px-4 py-1.5 text-xs border border-yellow/15">
								<span className="whitespace-pre-wrap">{m.content}</span>
							</div>
						);
					}
					return (
						<div
							key={i}
							// Keep a bubble tap from bubbling to the thread tap handler (which would
							// churn the mic on a double-tap-to-replay); double-tap still replays.
							onClick={(e) => e.stopPropagation()}
							onDoubleClick={() => playMessage(instanceId, m, voice.maybeSpeakResponse)}
							className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-pointer ${
								m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
									: "bg-panel border border-line self-start rounded-bl-sm"
							}`}
						>
							<button type="button" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(m.content); }} onDoubleClick={(e) => e.stopPropagation()} className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity" title="Copy"><Copy size={12} /></button>
							{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(instanceId, m, voice.maybeSpeakResponse); }} onDoubleClick={(e) => e.stopPropagation()} title="Play your recording" className="opacity-80 hover:opacity-100"><Volume2 size={11} /></button>}</span>{m.time && <span className="font-normal opacity-80">{formatDateTime(m.time)}</span>}</div>}
							{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span>Co-pilot</span>{m.time && <span className="font-normal text-muted">{formatDateTime(m.time)}</span>}</div>}
							{m.role === "assistant" ? (
								<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
							) : (
								<span className="whitespace-pre-wrap">{m.content}</span>
							)}
						</div>
					);
				})}
			</div>
			{/* Live voice status — the OBVIOUS "it heard you / is working" signal. Walks
			    Listening → Transcribing → Working, and is the tap target in Tap-to-talk. */}
			{(() => {
				const s = resolveVoiceStatus({
					mode: voice.mode,
					thinking: summaryBusy,
					transcribing: voice.interim === "Transcribing…",
					talking: voice.talking,
					listening: voice.micOn,
					speaking: voice.speaking,
					muted: voice.muted,
				});
				if (!s) return null;
				const cls = s.tone === "work" ? "bg-accent text-white ring-4 ring-accent/25 animate-pulse"
					: s.tone === "speak" ? "bg-accent text-white ring-4 ring-accent/25"
					: s.tone === "live" ? "bg-green text-white ring-4 ring-green/30 animate-pulse scale-105"
					: "bg-panel border border-line text-muted hover:text-accent hover:border-accent";
				const StatusIcon = s.icon === "spin" ? Loader2 : s.icon === "speak" ? Volume2 : Mic;
				return (
					<div className="absolute left-0 right-0 bottom-3 flex justify-center px-4 pointer-events-none z-20">
						<button type="button" onClick={s.tap ? voice.toggleTalk : undefined} disabled={!s.tap} aria-live="polite" className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm shadow-lg transition-all ${cls} ${s.tap ? "cursor-pointer" : "cursor-default"}`}>
							<StatusIcon size={16} className={s.icon === "spin" ? "animate-spin" : ""} />
							{s.label}
						</button>
					</div>
				);
			})()}
			</div>
		</div>
	);
}
