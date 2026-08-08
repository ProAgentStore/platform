import { useEffect, useState } from "react";
import { ALL_VOICE_COMMANDS, commandPhrases, type VoiceCommand } from "@proagentstore/sdk/hooks";

/**
 * The voice controls, rendered IDENTICALLY by the account Preferences page and by a per-agent
 * override on the instance Settings tab (#211).
 *
 * One component, two hosts. The controls used to exist only inside SettingsTab, which is why voice
 * could not be an account setting without duplicating ~220 lines of JSX — and a duplicate would
 * have drifted the moment one copy gained a field.
 *
 * The component owns the field state and re-seeds it whenever `value` changes (switching agents, or
 * toggling an override off). It never talks to the API: the host decides whether a change writes to
 * `/v1/preferences` or to that instance's override, which is the entire difference between them.
 */
/** A list field as an array, tolerating the delimited-string shape the API also accepts. */
function asList(v: unknown): string[] {
	const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n;]/) : [];
	return raw.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
}

/**
 * One command's row: its phrases, a "Use suggested" fill, and the switch that turns it OFF (#443).
 *
 * The switch is the point of the ticket — "exit cannot be turned off at all". It is a switch and
 * not an empty box because the two facts are independent: a blank box means "use our phrasings",
 * which are resolved per LANGUAGE at match time, so spending blankness on "off" would have meant
 * backfilling every account with today's English words and freezing them there.
 *
 * "Use suggested" fills the box from `commandPhrases` — the same function the matcher calls, for
 * the language currently selected above — so what you see is exactly what would have fired. It
 * only ever writes on your click; nothing is ever filled in on your behalf.
 */
function CommandField({ command, label, placeholder, hint, lang, value, onValue, off, onOff }: {
	command: VoiceCommand;
	label: string;
	placeholder: string;
	hint?: React.ReactNode;
	lang: string;
	value: string;
	onValue: (next: string, commit: boolean) => void;
	off: boolean;
	onOff: (next: boolean) => void;
}) {
	const id = `voice-cmd-${command}`;
	const suggested = commandPhrases(command, undefined, lang).join(", ");
	return (
		<div className="block">
			<div className="flex items-center justify-between gap-2 mb-0.5">
				<label htmlFor={id} className="text-xs font-semibold">{label}</label>
				<div className="flex items-center gap-2 shrink-0">
					{!off && !value.trim() && suggested && (
						<button type="button" aria-label={`Use suggested ${label}`} onClick={() => onValue(suggested, true)} className="text-2xs text-accent font-semibold">
							Use suggested
						</button>
					)}
					<label className="flex items-center gap-1 text-2xs text-muted-soft cursor-pointer">
						<input type="checkbox" checked={!off} onChange={(e) => onOff(!e.target.checked)} aria-label={`${label} enabled`} />
						{off ? "Off" : "On"}
					</label>
				</div>
			</div>
			<input
				id={id}
				value={value}
				disabled={off}
				onChange={(e) => onValue(e.target.value, false)}
				onBlur={() => onValue(value, true)}
				placeholder={off ? "Turned off" : placeholder}
				className="w-full bg-paper border border-line rounded-lg px-2.5 py-1.5 text-sm disabled:opacity-50"
			/>
			{hint && <span className="block text-2xs text-muted-soft mt-0.5">{hint}</span>}
		</div>
	);
}

export interface VoiceFieldsProps {
	/** The effective settings to display. */
	value: Record<string, unknown>;
	/** Persist one changed field. Rejecting shows the error inline. */
	onPatch: (patch: Record<string, unknown>) => Promise<unknown>;
	/** Whether the owner has an OpenAI key — Whisper STT and OpenAI TTS need one. */
	hasOpenAiKey: boolean | null;
	/** Shown under the controls after a successful save. */
	savedNote?: string;
}

export default function VoiceFields({ value, onPatch, hasOpenAiKey, savedNote = "Saved — applies on your next turn" }: VoiceFieldsProps) {
	const voiceSettings = value;
	const [sttMode, setSttMode] = useState("browser");
	const [sttModel, setSttModel] = useState("gpt-4o-transcribe");
	const [ttsProvider, setTtsProvider] = useState("browser");
	const [ttsVoice, setTtsVoice] = useState("alloy");
	const [speed, setSpeed] = useState(100);
	const [ttsMaxChars, setTtsMaxChars] = useState(1500);
	const [silenceMs, setSilenceMs] = useState(1500);
	const [maxDictationMs, setMaxDictationMs] = useState(60000);
	const [sensitivity, setSensitivity] = useState(0.8);
	const [language, setLanguage] = useState("en-US");
	const [commandsEnabled, setCommandsEnabled] = useState(true);
	const [keepAwake, setKeepAwake] = useState(true);
	const [repeatWords, setRepeatWords] = useState("");
	const [muteWords, setMuteWords] = useState("");
	const [unmuteWords, setUnmuteWords] = useState("");
	const [exitWords, setExitWords] = useState("");
	const [nextWords, setNextWords] = useState("");
	const [scrapWords, setScrapWords] = useState("");
	/** Commands switched OFF (#443) — "exit cannot be turned off at all" was the reported gap. */
	const [disabledCommands, setDisabledCommands] = useState<VoiceCommand[]>([]);
	const [stopWords, setStopWords] = useState("");
	/** THIS scope's own vocabulary (#373) — the account list on Preferences, this agent's own on
	 *  the Settings tab. Never the union: the box has to edit what this scope stores, or saving it
	 *  would copy the words above it into the scope below and quietly freeze them there. */
	const [vocabulary, setVocabulary] = useState("");
	const [stopSpeechKeyword, setStopSpeechKeyword] = useState("");
	const [confirmLanguage, setConfirmLanguage] = useState(true);
	const [voiceMsg, setVoiceMsg] = useState("");
	// Read straight off `value`, never held in state: neither is editable here, and both change
	// under the panel (attach a repo, edit your account list) without this scope saving anything.
	const inherited = asList(voiceSettings.inheritedVocabulary);
	const derived = asList(voiceSettings.derivedVocabulary);

	// Re-seed on every change of `value` — switching agents, or turning an override off, must
	// repaint the controls rather than leave the previous agent's numbers on screen.
	useEffect(() => {
		const vs = value || {};
		const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(", ") : typeof v === "string" ? v : "");
		setSttMode(typeof vs.sttMode === "string" ? vs.sttMode : "browser");
		setSttModel(typeof vs.sttModel === "string" ? vs.sttModel : "gpt-4o-transcribe");
		setTtsProvider(typeof vs.provider === "string" ? vs.provider : "browser");
		setTtsVoice(((vs.openai as Record<string, unknown>)?.voice as string) || "alloy");
		setSpeed(typeof vs.speed === "number" ? vs.speed : 100);
		setTtsMaxChars(typeof vs.ttsMaxChars === "number" ? vs.ttsMaxChars : 1500);
		setSilenceMs(typeof vs.silenceMs === "number" ? vs.silenceMs : 1500);
		setMaxDictationMs(typeof vs.maxDictationMs === "number" ? vs.maxDictationMs : 60000);
		setSensitivity(typeof vs.sensitivity === "number" ? vs.sensitivity : 0.8);
		setLanguage(typeof vs.language === "string" ? vs.language : "en-US");
		setCommandsEnabled(vs.commandsEnabled !== false);
		setKeepAwake(vs.keepAwake !== false);
		setRepeatWords(list(vs.repeatWords));
		setMuteWords(list(vs.muteWords));
		setUnmuteWords(list(vs.unmuteWords));
		setExitWords(list(vs.exitWords));
		setNextWords(list(vs.nextWords));
		setScrapWords(list(vs.scrapWords));
		setDisabledCommands(asList(vs.disabledCommands).filter((c): c is VoiceCommand => (ALL_VOICE_COMMANDS as readonly string[]).includes(c)));
		// `vocabulary` arrives RESOLVED (account ∪ this agent's) because that is what the recogniser
		// uses; subtracting the inherited half is what leaves this scope's own contribution.
		const inheritedKeys = new Set(asList(vs.inheritedVocabulary).map((t) => t.toLowerCase()));
		setVocabulary(asList(vs.vocabulary).filter((t) => !inheritedKeys.has(t.toLowerCase())).join(", "));
		setStopWords(list(vs.stopWords));
		setStopSpeechKeyword(typeof vs.stopSpeechKeyword === "string" ? vs.stopSpeechKeyword : "");
		setConfirmLanguage(vs.confirmLanguage !== false);
	}, [value]);

	/**
	 * Switch one command on or off (#443). Written immediately rather than on blur: a switch has no
	 * blur, and the state it expresses ("this command does not exist for me") is exactly the one a
	 * user would otherwise navigate away believing they had saved.
	 */
	const toggleCommand = (command: VoiceCommand, off: boolean) => {
		const next = off ? [...disabledCommands.filter((c) => c !== command), command] : disabledCommands.filter((c) => c !== command);
		setDisabledCommands(next);
		saveVoice({ disabledCommands: next });
	};

	const saveVoice = async (patch: Record<string, unknown>) => {
		try {
			await onPatch(patch);
			setVoiceMsg(savedNote);
			setTimeout(() => setVoiceMsg(""), 2500);
		} catch (e) {
			setVoiceMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	return (
		<>
			<label htmlFor="voice-stt-mode" className="block text-sm font-semibold mb-1">Speech recognition (how it hears you)</label>
			<p className="text-xs text-muted mb-2">
				<b>Dictation</b> shows words <b>live as you speak</b> (real-time) — on-device, instant, but error-prone with accents. <b>Smart (AI)</b> records your whole turn and transcribes it with OpenAI Whisper — far more accurate, but the text only appears <b>at the end</b> (no live words). Whisper needs your OpenAI key (Knowledge → Credentials; falls back to Dictation without it).
			</p>
			<select
				id="voice-stt-mode"
				value={sttMode}
				onChange={(e) => { setSttMode(e.target.value); saveVoice({ sttMode: e.target.value }); }}
				className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
			>
				<option value="browser">Dictation — real-time, words as you speak</option>
				<option value="openai">Smart (AI) — Whisper, most accurate (appears at end)</option>
			</select>
			{sttMode === "openai" && hasOpenAiKey !== null && (
				hasOpenAiKey ? (
					<p className="text-xs text-success mb-2">✓ OpenAI key found — voice is transcribed with Whisper (AI).</p>
				) : (
					<p className="text-xs text-danger mb-2">⚠ No OpenAI key found — Smart (AI) can't run, so it's still using plain dictation. Add your key in <b>Knowledge → Credentials</b> to enable Whisper.</p>
				)
			)}
			{/* The model was already read by resolveVoiceConfig but had no way in: the save route
			    never persisted it and nothing sent it, so it was pinned to the default forever.
			    Exposed here now that the shared sanitizer stores it (#211/T3). */}
			{sttMode === "openai" && (
				<>
					<label htmlFor="voice-stt-model" className="block text-sm font-semibold mb-1 mt-3">Transcription model</label>
					<select
						id="voice-stt-model"
						value={sttModel}
						onChange={(e) => { setSttModel(e.target.value); saveVoice({ sttModel: e.target.value }); }}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-1 block w-full sm:w-auto"
					>
						<option value="gpt-4o-transcribe">Realtime — words appear as you speak (default)</option>
						<option value="gpt-4o-mini-transcribe">Realtime mini — cheaper and faster, slightly less accurate</option>
						<option value="whisper-1">Whisper (legacy) — batch only, no live words</option>
					</select>
					<p className="text-2xs text-muted-soft mb-4">Only the realtime models stream partial words; whisper-1 returns the whole turn at the end.</p>
				</>
			)}

			<label htmlFor="voice-tts-provider" className="block text-sm font-semibold mb-1 mt-4">Voice output (how it speaks back)</label>
			<p className="text-xs text-muted mb-2">
				<b>Browser voice</b> is built-in and free. <b>Natural (OpenAI)</b> uses OpenAI TTS for a far more human voice (needs your OpenAI key; falls back to the browser voice without it).
			</p>
			<select
				id="voice-tts-provider"
				value={ttsProvider}
				onChange={(e) => { setTtsProvider(e.target.value); saveVoice({ provider: e.target.value }); }}
				className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
			>
				<option value="browser">Browser voice — free, on-device</option>
				<option value="openai-realtime">Natural (OpenAI) — human-sounding</option>
			</select>
			{ttsProvider.includes("openai") && hasOpenAiKey === false && (
				<p className="text-xs text-danger mb-2">⚠ No OpenAI key — using the browser voice. Add your key in <b>Knowledge → Credentials</b>.</p>
			)}
			{ttsProvider.includes("openai") && (
				<div className="mb-2">
					<label htmlFor="voice-openai-voice" className="block text-xs font-semibold mb-1">Voice</label>
					<select
						id="voice-openai-voice"
						value={ttsVoice}
						onChange={(e) => { setTtsVoice(e.target.value); saveVoice({ openai: { ...((voiceSettings?.openai as Record<string, unknown>) || {}), voice: e.target.value } }); }}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
					>
						{["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
							<option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>
						))}
					</select>
				</div>
			)}
			<div className="mb-1">
				<label htmlFor="voice-speed" className="block text-xs font-semibold mb-1">Speaking speed</label>
				<select
					id="voice-speed"
					value={speed}
					onChange={(e) => { setSpeed(Number(e.target.value)); saveVoice({ speed: Number(e.target.value) }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
				>
					<option value={75}>Slow — 0.75×</option>
					<option value={100}>Normal — 1×</option>
					<option value={125}>Fast — 1.25×</option>
					<option value={150}>Faster — 1.5×</option>
				</select>
			</div>

			{/* #179 — this was a hardcoded 1500-char cut inside cleanForSpeech, so a long answer
			    was silently clipped mid-sentence with no way to hear the rest (or, for someone who
			    only wants the gist, no way to make it shorter). The list stops at 4096 because
			    OpenAI TTS refuses a longer body — "read all of it" is not a value we can honour. */}
			<div className="mt-3">
				<label htmlFor="voice-tts-max-chars" className="block text-xs font-semibold mb-1">How much to read aloud</label>
				<select
					id="voice-tts-max-chars"
					value={ttsMaxChars}
					onChange={(e) => { setTtsMaxChars(Number(e.target.value)); saveVoice({ ttsMaxChars: Number(e.target.value) }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
				>
					<option value={400}>Just the gist — first ~400 characters</option>
					<option value={800}>Short — first ~800 characters</option>
					<option value={1500}>Standard — first ~1500 characters</option>
					<option value={3000}>Long — first ~3000 characters</option>
					<option value={4096}>Maximum — ~4096 characters</option>
				</select>
				<p className="text-2xs text-muted-soft mt-1">A long reply is cut off at this point when spoken — the full text is always on screen. Maximum is the most the natural (OpenAI) voice will accept in one go.</p>
			</div>

			<div className="border-t border-line my-3" />

			<label htmlFor="voice-silence" className="block text-sm font-semibold mb-1">Conversation — pause before sending</label>
			<p className="text-xs text-muted mb-2">
				How long to keep listening after you stop talking. Higher = pause mid-sentence without being cut off.
			</p>
			<div className="flex items-center gap-2 flex-wrap">
				<select
					id="voice-silence"
					value={silenceMs}
					onChange={(e) => { setSilenceMs(Number(e.target.value)); saveVoice({ silenceMs: Number(e.target.value) }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
				>
					<option value={800}>Quick — 0.8s pause</option>
					<option value={1500}>Normal — 1.5s pause</option>
					<option value={2500}>Relaxed — 2.5s pause</option>
					<option value={4000}>Patient — 4s pause</option>
				</select>
				{voiceMsg && <span className="text-sm text-muted">{voiceMsg}</span>}
			</div>

			<label htmlFor="voice-max-dictation" className="block text-sm font-semibold mb-1 mt-4">Max dictation time</label>
			<p className="text-xs text-muted mb-2">
				Hands-free stops listening and submits after this long, no matter what — so an open mic can't record forever.
			</p>
			<div className="flex items-center gap-2 flex-wrap">
				<select
					id="voice-max-dictation"
					value={maxDictationMs}
					onChange={(e) => { setMaxDictationMs(Number(e.target.value)); saveVoice({ maxDictationMs: Number(e.target.value) }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
				>
					<option value={30000}>30 seconds</option>
					<option value={60000}>1 minute</option>
					<option value={120000}>2 minutes</option>
					<option value={300000}>5 minutes</option>
				</select>
			</div>

			{/* Mic sensitivity — only Whisper (AI) uses the mic-level pause detector. */}
			{sttMode === "openai" && (
				<div className="mt-4">
					<label htmlFor="voice-sensitivity" className="block text-sm font-semibold mb-1">Mic sensitivity</label>
					<p className="text-xs text-muted mb-2">
						How readily background sound counts as speech. Lower = ignores more room/keyboard/fan noise (recommended). Raise it only if it cuts you off or misses a soft voice. If it keeps listening and never sends, lower it.
					</p>
					<select
						id="voice-sensitivity"
						value={sensitivity}
						onChange={(e) => { setSensitivity(Number(e.target.value)); saveVoice({ sensitivity: Number(e.target.value) }); }}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
					>
						<option value={0.6}>Low — very noisy room</option>
						<option value={0.8}>Standard — filters background noise (recommended)</option>
						<option value={1}>Normal</option>
						<option value={1.5}>High — quiet mic / soft voice</option>
					</select>
				</div>
			)}

			<div className="border-t border-line my-3" />

			<label htmlFor="voice-language" className="block text-sm font-semibold mb-1">Language</label>
			<p className="text-xs text-muted mb-2">Language for both speech recognition and the spoken voice.</p>
			<select
				id="voice-language"
				value={language}
				onChange={(e) => { setLanguage(e.target.value); saveVoice({ language: e.target.value }); }}
				className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-1 block w-full sm:w-auto"
			>
				{[["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-AU", "English (Australia)"], ["es-ES", "Spanish"], ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["pt-BR", "Portuguese (Brazil)"], ["hi-IN", "Hindi"], ["zh-CN", "Chinese (Mandarin)"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"]].map(([code, label]) => (
					<option key={code} value={code}>{label}</option>
				))}
			</select>

			<div className="border-t border-line my-3" />

			<div className="block text-sm font-semibold mb-1">Voice commands</div>
			<p className="text-xs text-muted mb-2">
				In hands-free mode, speak a command instead of a message and it acts locally:
			</p>
			<ul className="text-xs text-muted mb-2 space-y-1">
				<li>• <b>"Repeat"</b> (or "say again", "pardon", "what did you say") — re-speaks the agent's last reply.</li>
			</ul>
			<label className="flex items-center gap-2 text-sm cursor-pointer">
				<input
					type="checkbox"
					checked={commandsEnabled}
					onChange={(e) => { setCommandsEnabled(e.target.checked); saveVoice({ commandsEnabled: e.target.checked }); }}
				/>
				Enable voice commands
			</label>
			<p className="text-2xs text-muted-soft mt-1">Off = a spoken "repeat"/"mute" is sent as a normal message.</p>

			<div className="border-t border-line my-3" />

			{/* Vocabulary (#373). Placed with the recognition controls rather than the command
			    keywords below, because it is not a command: it changes what the recogniser HEARS,
			    not what a heard word does. */}
			<label className="block">
				<span className="block text-sm font-semibold mb-0.5">My vocabulary</span>
				<input
					value={vocabulary}
					onChange={(e) => setVocabulary(e.target.value)}
					onBlur={() => saveVoice({ vocabulary })}
					placeholder="tmux, HeartFull, Vectorize  (comma-separated)"
					className="w-full bg-paper border border-line rounded-lg px-2.5 py-1.5 text-sm"
				/>
				<span className="block text-2xs text-muted-soft mt-0.5">
					Words you say that get misheard — names, products, jargon. Smart (AI) recognition is told to
					expect them; browser dictation can't be steered, so a word that comes back <i>close</i> to one
					of these is corrected to match. Only whole words, only a very near miss — a mishearing that
					isn't close to anything here is left exactly as it arrived.
				</span>
			</label>
			{inherited.length > 0 && (
				<div className="mt-2">
					<span className="block text-2xs text-muted-soft mb-1">
						{/* The one place the UNION is stated. Everything else on this panel is an override —
						    "customise for this agent" means INSTEAD OF — and vocabulary means AS WELL AS. */}
						Also applied here, from <b>Preferences → Voice</b> (these add to the list above, they don't replace it):
					</span>
					<div className="flex flex-wrap gap-1">
						{inherited.map((t) => (
							<span key={t} className="text-2xs bg-paper border border-line rounded-full px-2 py-0.5">{t}</span>
						))}
					</div>
				</div>
			)}
			{derived.length > 0 && (
				<div className="mt-2">
					<span className="block text-2xs text-muted-soft mb-1">
						Already known — this agent's name, its repos, the agents it works with. Nothing to type:
					</span>
					<div className="flex flex-wrap gap-1">
						{derived.map((t) => (
							<span key={t} className="text-2xs bg-paper border border-line rounded-full px-2 py-0.5 opacity-70">{t}</span>
						))}
					</div>
				</div>
			)}

			<div className="border-t border-line my-3" />

			{/* Configurable command keywords. Comma-separated. Each command has its own on/off
			    switch (#443); the two keyword fields at the bottom are not commands and have no
			    built-in phrasings, which is why blank means off for those two and only those two. */}
			<p className="text-2xs text-muted-soft mt-3">These <b>override</b> your global voice commands (Preferences → Voice) for this agent only. Leave a box blank to use our phrasings for your language — they follow the language you set above, so they change when it does. Anything you type wins over our built-ins, and the same phrase is never read as two different commands. Use the switch to turn a command <b>off</b> entirely.</p>
			<div className="grid gap-2.5 mt-2">
				<CommandField
					command="repeat" label="Repeat keywords" lang={language}
					placeholder="repeat, say again  (blank = our phrasings)"
					value={repeatWords} onValue={(v, commit) => { setRepeatWords(v); if (commit) saveVoice({ repeatWords: v }); }}
					off={disabledCommands.includes("repeat")} onOff={(off) => toggleCommand("repeat", off)}
				/>
				<CommandField
					command="mute" label="Mute keywords" lang={language}
					placeholder="mute, mute mic  (blank = our phrasings)"
					hint="Say one to mute the mic and stop the agent mid-sentence. Say an unmute word below to come back."
					value={muteWords} onValue={(v, commit) => { setMuteWords(v); if (commit) saveVoice({ muteWords: v }); }}
					off={disabledCommands.includes("mute")} onOff={(off) => toggleCommand("mute", off)}
				/>
				<CommandField
					command="unmute" label="Unmute keywords" lang={language}
					placeholder="unmute, start listening  (blank = our phrasings)"
					hint="Only listened for while you're muted, so these words can't interrupt a normal sentence. A short beep confirms the mic is live. Not available on iOS Safari, which has no background recogniser."
					value={unmuteWords} onValue={(v, commit) => { setUnmuteWords(v); if (commit) saveVoice({ unmuteWords: v }); }}
					off={disabledCommands.includes("unmute")} onOff={(off) => toggleCommand("unmute", off)}
				/>
				<CommandField
					command="exit" label="Exit-voice keywords" lang={language}
					placeholder="exit voice, text mode  (blank = our phrasings)"
					hint="Leaves voice entirely and returns to typing — unlike mute, which keeps the session live. Turn it off if you never want a spoken word to end the session."
					value={exitWords} onValue={(v, commit) => { setExitWords(v); if (commit) saveVoice({ exitWords: v }); }}
					off={disabledCommands.includes("exit")} onOff={(off) => toggleCommand("exit", off)}
				/>
				<CommandField
					command="next" label="Next-agent keywords" lang={language}
					placeholder="next, switch agent  (blank = our phrasings)"
					hint={<>Moves you to the agent that's asking for you, and says which one out loud. Nothing waiting? It says so and stays put. A one-word keyword only fires when it's your whole sentence, so “what's next?” is still a message.</>}
					value={nextWords} onValue={(v, commit) => { setNextWords(v); if (commit) saveVoice({ nextWords: v }); }}
					off={disabledCommands.includes("next")} onOff={(off) => toggleCommand("next", off)}
				/>
				<CommandField
					command="scrap" label="Scrap-turn keywords" lang={language}
					placeholder="scrap that, scratch that  (blank = our phrasings)"
					hint={<>Deletes your last exchange — your message, the reply and the tool log — after showing you what it's about to remove. The only destructive voice command, so it fires ONLY when the phrase is your entire sentence: “don't scrap that, keep it” stays a message. It can't undo what the turn already did, and says so.</>}
					value={scrapWords} onValue={(v, commit) => { setScrapWords(v); if (commit) saveVoice({ scrapWords: v }); }}
					off={disabledCommands.includes("scrap")} onOff={(off) => toggleCommand("scrap", off)}
				/>
				<label className="block">
					<span className="block text-xs font-semibold mb-0.5">Stop-word — finish my turn</span>
					<input value={stopWords} onChange={(e) => setStopWords(e.target.value)} onBlur={() => saveVoice({ stopWords })} placeholder="e.g. copy, over  (blank = off)" className="w-full bg-paper border border-line rounded-lg px-2.5 py-1.5 text-sm" />
					<span className="block text-2xs text-muted-soft mt-0.5">Say it at the end (“…do it, <b>copy</b>”) to send immediately without waiting for a pause — it's stripped from your message. Not a command and it has no suggested phrasings, which is why this box has no switch: blank <b>is</b> off. Off by default since it's an everyday word.</span>
				</label>
				<label className="block">
					<span className="block text-xs font-semibold mb-0.5">Stop-speech keyword — interrupt the agent</span>
					<input value={stopSpeechKeyword} onChange={(e) => setStopSpeechKeyword(e.target.value)} onBlur={() => saveVoice({ stopSpeechKeyword })} placeholder="e.g. stop stop  (blank = off)" className="w-full bg-paper border border-line rounded-lg px-2.5 py-1.5 text-sm" />
					<span className="block text-2xs text-muted-soft mt-0.5">Say it <b>while the agent is talking</b> to halt playback immediately (hands-free keeps listening through TTS when this is set). Like the stop-word above, it has no suggested phrasings, so blank <b>is</b> off and there is no switch. Pick a distinctive phrase so the agent's own speech can't trigger it. A phrase you set here is <b>yours</b> — it won't also be read as an exit or mute word, even if it's one of our built-in ones.</span>
				</label>
			</div>

			<div className="border-t border-line my-3" />

			<div className="block text-sm font-semibold mb-1">Confirm my language</div>
			<p className="text-xs text-muted mb-2">
				Lock speech recognition to your set language. If a phrase is briefly mis-heard as another language (e.g. Korean or Japanese), it's ignored and you're asked to repeat — the agent never responds in a language you didn't choose. Turn off to allow any detected language through.
			</p>
			<label className="flex items-center gap-2 text-sm cursor-pointer mb-3">
				<input
					type="checkbox"
					checked={confirmLanguage}
					onChange={(e) => { setConfirmLanguage(e.target.checked); saveVoice({ confirmLanguage: e.target.checked }); }}
				/>
				Ignore speech detected as a different language
			</label>

			<div className="block text-sm font-semibold mb-1">Keep screen awake</div>
			<p className="text-xs text-muted mb-2">
				In hands-free mode, hold a screen wake lock so the display doesn't dim or lock and cut off the mic. Note: on iOS this only keeps it going while the app is open — switching apps or locking still pauses it (it resumes when you return).
			</p>
			<label className="flex items-center gap-2 text-sm cursor-pointer">
				<input
					type="checkbox"
					checked={keepAwake}
					onChange={(e) => { setKeepAwake(e.target.checked); saveVoice({ keepAwake: e.target.checked }); }}
				/>
				Keep the screen awake during hands-free
			</label>
			<p className="text-2xs text-muted-soft mt-1">Off = the screen may sleep on its own timer (saves battery, but ends the conversation when it does).</p>
		</>
	);
}
