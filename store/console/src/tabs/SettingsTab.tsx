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
	const [sttMode, setSttMode] = useState("browser");
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [voiceMsg, setVoiceMsg] = useState("");

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
				if (typeof vs.sttMode === "string") setSttMode(vs.sttMode);
			} catch {}
			// Is there an OpenAI key? Smart (AI) recognition silently falls back to
			// browser dictation without one, so surface it explicitly.
			try {
				const k = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
				setHasOpenAiKey(!!k.providers?.find((p) => p.id === "openai")?.hasKey);
			} catch {
				setHasOpenAiKey(false);
			}
		})();
	}, [instanceId]);

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

			{/* Voice */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>

				<label className="block text-sm font-semibold mb-1">Recognition</label>
				<p className="text-xs text-muted mb-2">
					<b>Dictation</b> is instant but error-prone with accents. <b>Smart (AI)</b> records and transcribes with OpenAI Whisper — far more accurate (needs your OpenAI key in Knowledge → Credentials; falls back to dictation without it).
				</p>
				<select
					value={sttMode}
					onChange={(e) => { setSttMode(e.target.value); saveVoice({ sttMode: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
				>
					<option value="browser">Dictation — fast, on-device</option>
					<option value="openai">Smart (AI) — Whisper, most accurate</option>
				</select>
				{sttMode === "openai" && hasOpenAiKey !== null && (
					hasOpenAiKey ? (
						<p className="text-xs text-green mb-4">✓ OpenAI key found — voice is transcribed with Whisper (AI).</p>
					) : (
						<p className="text-xs text-red mb-4">⚠ No OpenAI key found — Smart (AI) can't run, so it's still using plain dictation. Add your key in <b>Knowledge → Credentials</b> to enable Whisper.</p>
					)
				)}

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
