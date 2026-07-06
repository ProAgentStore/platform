import { type RefObject } from "react";
import { renderMd, formatTime } from "@proagentstore/sdk/ui";
import { API, getToken } from "@proagentstore/sdk/client";
import { Trash2, Copy, Repeat, Square, Mic, MicOff, Volume2, AudioLines, Send, Wrench, Eye } from "lucide-react";

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
				await audio.play();
				return;
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
}) {
	return (
		<div className="flex flex-col flex-1 min-h-0">
			{/* Input bar — top, always visible. Compact input, big controls. */}
			<div className="flex gap-1.5 px-2 py-1.5 shrink-0 items-center border-b border-line">
				<div className="flex-1 min-w-0 relative">
					<input
						value={voice.interim || chatInput}
						onChange={(e) => { if (!voice.interim) setChatInput(e.target.value); }}
						onKeyDown={(e) => { if (e.key === "Enter" && !voice.interim) sendInstruction(); }}
						placeholder={voice.micOn ? "Listening — speak now…" : voice.convoOn ? "Conversation mode — just talk" : "Ask or tell the agent…"}
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
			{/* Controls bar — labeled voice buttons (icon-only was ambiguous: two mic-like glyphs) */}
			<div className="flex flex-wrap gap-1.5 px-2 py-1.5 shrink-0 items-center">
				<button type="button" onClick={voice.toggleMic} title="Talk: tap once, speak, and it sends when you pause (one at a time)" className={`flex items-center gap-1.5 px-2.5 py-2 border rounded-lg transition-colors ${voice.micOn ? "border-accent bg-accent text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
					<Mic size={16} /><span className="text-xs font-semibold">Talk</span>
				</button>
				<button type="button" onClick={voice.toggleSpeak} title="Speak replies: read every agent reply aloud (doesn't listen)" className={`flex items-center gap-1.5 px-2.5 py-2 border rounded-lg transition-colors ${voice.speakOn ? "border-accent bg-accent text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
					<Volume2 size={16} /><span className="text-xs font-semibold">Speak</span>
				</button>
				<button type="button" onClick={voice.toggleConvo} title="Hands-free: continuous conversation — you talk, it replies aloud, then listens again" className={`flex items-center gap-1.5 px-2.5 py-2 border rounded-lg transition-colors ${voice.convoOn ? "border-green bg-green text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
					<AudioLines size={16} /><span className="text-xs font-semibold">Hands-free</span>
				</button>
				{voice.convoOn && (
					<button type="button" onClick={voice.toggleMute} title={voice.muted ? "Unmute the mic" : "Mute the mic (stay in hands-free)"} className={`flex items-center gap-1.5 px-2.5 py-2 border rounded-lg transition-colors ${voice.muted ? "border-red bg-red text-white" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<MicOff size={16} /><span className="text-xs font-semibold">{voice.muted ? "Muted" : "Mute"}</span>
					</button>
				)}
				{loop.loopOn ? (
					<button type="button" onClick={loop.stop} title={`Loop ${loop.loopIteration}/${loop.loopMax}`} className="px-2.5 py-2 border border-green bg-green/15 text-green rounded-lg relative">
						<Square size={17} />
						<span className="absolute -top-1 -right-1 text-[0.55rem] bg-green text-white rounded-full px-1 font-bold leading-tight">{loop.loopIteration}</span>
					</button>
				) : (
					<button type="button" onClick={() => loop.setShowLoopForm(!loop.showLoopForm)} title="Loop" className={`px-2.5 py-2 border rounded-lg ${loop.showLoopForm ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-accent"}`}>
						<Repeat size={17} />
					</button>
				)}
				<button type="button" onClick={onClearChat} title="Clear chat" className="px-2.5 py-2 border border-line rounded-lg text-red hover:bg-red/10 transition-colors">
					<Trash2 size={17} />
				</button>
			</div>
			{/* Scope hint — this is NOT the general Assistant chat; it's tied to THIS session. */}
			<div className="px-3 pb-1.5 shrink-0 text-[0.7rem] text-muted-soft flex items-center gap-1">
				<Eye size={11} className="shrink-0" /> Co-pilot — watching this coding session
			</div>
			{/* Loop form with presets */}
			{loop.showLoopForm && !loop.loopOn && (
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
						<label className="text-xs text-muted flex items-center gap-1.5">Max iterations: <input type="number" value={loop.loopMax} onChange={(e) => loop.setLoopMax(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))} className="w-14 bg-panel border border-line rounded px-2 py-1 text-xs" min={1} max={50} /></label>
						<div className="flex gap-1.5">
							<button type="button" onClick={() => loop.setShowLoopForm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold">Cancel</button>
							<button type="button" onClick={loop.start} disabled={!loop.loopObjective.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold disabled:opacity-40">Start Loop</button>
						</div>
					</div>
				</div>
			)}
			{/* Messages */}
			<div ref={threadRef} className="flex-1 overflow-y-auto flex flex-col gap-2 px-2 py-2 chat-scroll">
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
							onClick={() => voice.cancelSpeak()}
							onDoubleClick={() => playMessage(instanceId, m, voice.maybeSpeakResponse)}
							className={`group relative max-w-[90%] px-3 py-2 rounded-xl text-sm leading-relaxed cursor-pointer ${
								m.role === "user" ? "bg-accent text-white self-end rounded-br-sm"
									: "bg-panel border border-line self-start rounded-bl-sm"
							}`}
						>
							<button type="button" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(m.content); }} className="absolute top-1 right-1.5 opacity-0 group-hover:opacity-100 text-[0.65rem] px-1.5 py-0.5 rounded bg-black/50 text-muted transition-opacity" title="Copy"><Copy size={12} /></button>
							{m.role === "user" && <div className="text-[0.65rem] opacity-70 mb-0.5 font-bold flex items-center justify-between gap-3"><span className="flex items-center gap-1">You{m.audioKey && <button type="button" onClick={(e) => { e.stopPropagation(); playMessage(instanceId, m, voice.maybeSpeakResponse); }} title="Play your recording" className="opacity-80 hover:opacity-100"><Volume2 size={11} /></button>}</span>{m.time && <span className="font-normal opacity-80">{formatTime(m.time)}</span>}</div>}
							{m.role === "assistant" && <div className="text-[0.65rem] text-accent mb-0.5 font-bold flex items-center justify-between gap-3"><span>Co-pilot</span>{m.time && <span className="font-normal text-muted">{formatTime(m.time)}</span>}</div>}
							{m.role === "assistant" ? (
								<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
							) : (
								<span className="whitespace-pre-wrap">{m.content}</span>
							)}
						</div>
					);
				})}
				{summaryBusy && <div className="text-muted text-sm flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-accent animate-pulse" />Thinking...</div>}
			</div>
		</div>
	);
}
