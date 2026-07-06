import { useState, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";

interface Props {
	instanceId: string;
	isApply: boolean;
	onUnsubscribe: () => void;
}

export default function SettingsTab({ instanceId, isApply, onUnsubscribe }: Props) {
	const [maintMsg, setMaintMsg] = useState("");
	const [runtimeInfo, setRuntimeInfo] = useState<Record<string, unknown> | null>(null);
	const [voiceSettings, setVoiceSettings] = useState<Record<string, unknown> | null>(null);
	const [silenceMs, setSilenceMs] = useState(1500);
	const [sensitivity, setSensitivity] = useState(1);
	const [sttMode, setSttMode] = useState("browser");
	const [ttsProvider, setTtsProvider] = useState("browser");
	const [ttsVoice, setTtsVoice] = useState("alloy");
	const [speed, setSpeed] = useState(100);
	const [language, setLanguage] = useState("en-US");
	const [commandsEnabled, setCommandsEnabled] = useState(true);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [voiceMsg, setVoiceMsg] = useState("");
	const [emailStatus, setEmailStatus] = useState<{ connected: boolean; configured: boolean; email?: string | null } | null>(null);
	const [emailPermission, setEmailPermission] = useState<boolean | null>(null);
	const [emailMsg, setEmailMsg] = useState("");

	useEffect(() => {
		(async () => {
			try {
				const d = await api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`);
				setRuntimeInfo(d);
			} catch {}
			try {
				const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`);
				const vs = d.voiceSettings || {};
				setVoiceSettings(vs);
				if (typeof vs.silenceMs === "number") setSilenceMs(vs.silenceMs);
				if (typeof vs.sensitivity === "number") setSensitivity(vs.sensitivity);
				if (typeof vs.sttMode === "string") setSttMode(vs.sttMode);
				if (typeof vs.provider === "string") setTtsProvider(vs.provider);
				if (typeof vs.speed === "number") setSpeed(vs.speed);
				if (typeof vs.language === "string") setLanguage(vs.language);
				if (typeof vs.commandsEnabled === "boolean") setCommandsEnabled(vs.commandsEnabled);
				const oa = vs.openai as Record<string, unknown> | undefined;
				if (oa && typeof oa.voice === "string") setTtsVoice(oa.voice);
			} catch {}
			// Is there an OpenAI key? Smart (AI) recognition silently falls back to
			// browser dictation without one, so surface it explicitly.
			try {
				const k = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
				setHasOpenAiKey(!!k.providers?.find((p) => p.id === "openai")?.hasKey);
			} catch {
				setHasOpenAiKey(false);
			}
			await refreshEmail();
			try {
				const st = await api<{ permissions?: { email?: boolean } }>(`/v1/instances/${instanceId}/state`);
				setEmailPermission(st.permissions?.email === true);
			} catch {}
		})();
	}, [instanceId]);

	// Gmail is connected in a popup; re-check when the user returns to this tab.
	const refreshEmail = async () => {
		try {
			const s = await api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status");
			setEmailStatus(s);
		} catch {}
	};
	useEffect(() => {
		const onFocus = () => { refreshEmail(); };
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Merge so a PUT (which replaces the whole object) doesn't wipe other settings.
	const saveVoice = async (patch: Record<string, unknown>) => {
		const next = { ...(voiceSettings || {}), ...patch };
		setVoiceSettings(next);
		try {
			await api(`/v1/instances/${instanceId}/voice-settings`, { method: "PUT", body: JSON.stringify(next) });
			setVoiceMsg("Saved — applies on your next turn");
			setTimeout(() => setVoiceMsg(""), 2500);
		} catch (e) {
			setVoiceMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const connectGmail = async () => {
		try {
			const { url } = await api<{ url: string }>("/v1/email/google/start");
			window.open(url, "_blank", "noopener");
			setEmailMsg("Complete the Google sign-in in the new tab, then come back here.");
		} catch (e) {
			setEmailMsg(e instanceof Error ? e.message : "Failed to start Gmail connection");
		}
	};

	const disconnectGmail = async () => {
		if (!confirm("Disconnect Gmail? Agents will no longer be able to read your inbox for sign-in links.")) return;
		try {
			await api("/v1/email/google", { method: "DELETE" });
			setEmailStatus((s) => (s ? { ...s, connected: false } : s));
			setEmailMsg("Gmail disconnected.");
		} catch (e) {
			setEmailMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const toggleEmailPermission = async (on: boolean) => {
		setEmailPermission(on);
		try {
			await api(`/v1/instances/${instanceId}/state`, { method: "PUT", body: JSON.stringify({ permissions: { email: on } }) });
			setEmailMsg(on ? "This agent can now read your inbox for sign-in links & codes." : "Email access turned off for this agent.");
		} catch (e) {
			setEmailPermission(!on); // revert on failure
			setEmailMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const clearFinished = async () => {
		try {
			await api(`/v1/instances/${instanceId}/tasks/clear-finished`, { method: "POST" });
			setMaintMsg("Cleared finished tasks");
			setTimeout(() => setMaintMsg(""), 3000);
		} catch (e) {
			setMaintMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const unsubscribe = async () => {
		if (!confirm("Unsubscribe from this agent? Your data stays unless you clear it.")) return;
		try {
			await api(`/v1/instances/${instanceId}/cancel`, { method: "POST" });
			onUnsubscribe();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div>
			{/* Board maintenance */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Board maintenance</h3>
				<p className="text-sm text-muted mb-3">
					Tidy up the board. These only clear your view of finished items.
				</p>
				<div className="flex gap-2 flex-wrap">
					<button
						type="button"
						onClick={clearFinished}
						className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold"
					>
						Clear finished tasks
					</button>
				</div>
				{maintMsg && <div className="text-sm text-muted mt-2">{maintMsg}</div>}
			</div>

			{/* Runner info */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Runner</h3>
				<div className="text-sm text-muted leading-relaxed">
					{runtimeInfo ? (
						<>
							Status: {String((runtimeInfo as Record<string, unknown>).connected ? "Online" : "Offline")}
							{(runtimeInfo as Record<string, unknown>).node && (
								<> · Node: {String((runtimeInfo as Record<string, unknown>).node)}</>
							)}
						</>
					) : (
						"Checking runner status..."
					)}
				</div>
			</div>

			{/* Where things live */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && <li><b>Resume</b> & documents → Knowledge → Documents</li>}
					{isApply && <li><b>Candidate profile</b> & job preferences → Profile</li>}
					<li><b>Rules / special instructions</b> → Knowledge → Rules & Tips</li>
					<li><b>Logins & secrets</b> → Knowledge → Credentials</li>
				</ul>
			</div>

			{/* Permissions & Connections */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
				<p className="text-sm text-muted mb-3">
					Connect Gmail so this agent can read <b>one-time sign-in links and verification codes</b> when a site (e.g. a job portal) emails one — instead of pausing to ask you.
				</p>

				{emailStatus && !emailStatus.configured && (
					<p className="text-xs text-red mb-2">Email connection isn’t configured on this deployment yet.</p>
				)}

				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="text-sm">
						<span className="font-semibold">Gmail</span>{" "}
						{emailStatus?.connected
							? <span className="text-green">· connected{emailStatus.email ? ` (${emailStatus.email})` : ""}</span>
							: <span className="text-muted">· not connected</span>}
					</div>
					{emailStatus?.configured && (
						emailStatus.connected ? (
							<button type="button" onClick={disconnectGmail} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-bold">
								Disconnect
							</button>
						) : (
							<button type="button" onClick={connectGmail} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold">
								Connect Gmail
							</button>
						)
					)}
				</div>

				<label className={`flex items-center gap-2 text-sm ${emailStatus?.connected ? "" : "opacity-50"}`}>
					<input
						type="checkbox"
						checked={emailPermission === true}
						disabled={!emailStatus?.connected}
						onChange={(e) => toggleEmailPermission(e.target.checked)}
					/>
					<span>Allow <b>this agent</b> to read my inbox for sign-in links &amp; codes</span>
				</label>
				{!emailStatus?.connected && (
					<p className="text-xs text-muted mt-1">Connect Gmail above to enable this.</p>
				)}
				{emailMsg && <div className="text-xs text-muted mt-2">{emailMsg}</div>}
			</div>

			{/* Voice */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>

				<label className="block text-sm font-semibold mb-1">Speech recognition (how it hears you)</label>
				<p className="text-xs text-muted mb-2">
					<b>Dictation</b> shows words <b>live as you speak</b> (real-time) — on-device, instant, but error-prone with accents. <b>Smart (AI)</b> records your whole turn and transcribes it with OpenAI Whisper — far more accurate, but the text only appears <b>at the end</b> (no live words). Whisper needs your OpenAI key (Knowledge → Credentials; falls back to Dictation without it).
				</p>
				<select
					value={sttMode}
					onChange={(e) => { setSttMode(e.target.value); saveVoice({ sttMode: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
				>
					<option value="browser">Dictation — real-time, words as you speak</option>
					<option value="openai">Smart (AI) — Whisper, most accurate (appears at end)</option>
				</select>
				{sttMode === "openai" && hasOpenAiKey !== null && (
					hasOpenAiKey ? (
						<p className="text-xs text-green mb-4">✓ OpenAI key found — voice is transcribed with Whisper (AI).</p>
					) : (
						<p className="text-xs text-red mb-4">⚠ No OpenAI key found — Smart (AI) can't run, so it's still using plain dictation. Add your key in <b>Knowledge → Credentials</b> to enable Whisper.</p>
					)
				)}

				<label className="block text-sm font-semibold mb-1 mt-4">Voice output (how it speaks back)</label>
				<p className="text-xs text-muted mb-2">
					<b>Browser voice</b> is built-in and free. <b>Natural (OpenAI)</b> uses OpenAI TTS for a far more human voice (needs your OpenAI key; falls back to the browser voice without it).
				</p>
				<select
					value={ttsProvider}
					onChange={(e) => { setTtsProvider(e.target.value); saveVoice({ provider: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
				>
					<option value="browser">Browser voice — free, on-device</option>
					<option value="openai-realtime">Natural (OpenAI) — human-sounding</option>
				</select>
				{ttsProvider.includes("openai") && hasOpenAiKey === false && (
					<p className="text-xs text-red mb-2">⚠ No OpenAI key — using the browser voice. Add your key in <b>Knowledge → Credentials</b>.</p>
				)}
				{ttsProvider.includes("openai") && (
					<div className="mb-2">
						<label className="block text-xs font-semibold mb-1">Voice</label>
						<select
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
					<label className="block text-xs font-semibold mb-1">Speaking speed</label>
					<select
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

				<div className="border-t border-line my-3" />

				<label className="block text-sm font-semibold mb-1">Conversation — pause before sending</label>
				<p className="text-xs text-muted mb-2">
					How long to keep listening after you stop talking. Higher = pause mid-sentence without being cut off.
				</p>
				<div className="flex items-center gap-2 flex-wrap">
					<select
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

				{/* Mic sensitivity — only Whisper (AI) uses the mic-level pause detector. */}
				{sttMode === "openai" && (
					<div className="mt-4">
						<label className="block text-sm font-semibold mb-1">Mic sensitivity</label>
						<p className="text-xs text-muted mb-2">
							If it keeps listening and never sends, your mic is noisy — lower this. If it cuts you off too soon, raise it.
						</p>
						<select
							value={sensitivity}
							onChange={(e) => { setSensitivity(Number(e.target.value)); saveVoice({ sensitivity: Number(e.target.value) }); }}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
						>
							<option value={0.6}>Low — noisy mic / room</option>
							<option value={1}>Normal</option>
							<option value={1.5}>High — quiet mic / soft voice</option>
						</select>
					</div>
				)}

				<div className="border-t border-line my-3" />

				<label className="block text-sm font-semibold mb-1">Language</label>
				<p className="text-xs text-muted mb-2">Language for both speech recognition and the spoken voice.</p>
				<select
					value={language}
					onChange={(e) => { setLanguage(e.target.value); saveVoice({ language: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-1 block w-full sm:w-auto"
				>
					{[["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-AU", "English (Australia)"], ["es-ES", "Spanish"], ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["pt-BR", "Portuguese (Brazil)"], ["hi-IN", "Hindi"], ["zh-CN", "Chinese (Mandarin)"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"]].map(([code, label]) => (
						<option key={code} value={code}>{label}</option>
					))}
				</select>

				<div className="border-t border-line my-3" />

				<label className="block text-sm font-semibold mb-1">Voice commands</label>
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
						className="w-4 h-4 accent-accent"
					/>
					Enable voice commands
				</label>
				<p className="text-[0.7rem] text-muted-soft mt-1">Off = a spoken "repeat" is sent as a normal message.</p>
			</div>

			{/* Danger zone */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4">
				<h3 className="text-base font-bold mb-1 text-red">Danger zone</h3>
				<p className="text-sm text-muted mb-3">
					Stop using this agent. Your data stays unless you clear it above.
				</p>
				<button
					type="button"
					onClick={unsubscribe}
					className="text-xs px-3 py-1.5 rounded-lg border border-red text-red font-bold hover:bg-red/10"
				>
					Unsubscribe from this agent
				</button>
			</div>
		</div>
	);
}
