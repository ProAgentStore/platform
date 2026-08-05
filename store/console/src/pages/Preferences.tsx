import { useCallback, useEffect, useState } from "react";
import Page from "../components/Page";
import { api } from "@proagentstore/sdk/client";
import VoiceFields from "../components/VoiceFields";
import TranslationFields from "../components/TranslationFields";

/**
 * How YOU speak, hear and read — across every agent (#211).
 *
 * Split out of the instance Settings tab, which mixed three scopes: what an agent IS (its repo,
 * its runner, its triggers), how the OWNER likes things (voice, translation), and the danger zone.
 * Only the first and third are properties of an agent. Configuring your own speech-recognition
 * preference once per agent was the tell — and a new subscription seeded none of it, so every agent
 * you added made you re-tune from platform defaults.
 *
 * Split out of Profile too, which is identity and money: account, profile, candidate profile, API
 * token, billing, keys. Appearance moved here because it is the same kind of thing as the rest of
 * this page — a preference, not an identity.
 *
 * An agent can still differ: its Settings tab offers "Customise for this agent", which writes a
 * per-instance override. This page is what that override falls back to.
 */
export default function Preferences() {
	const [voice, setVoice] = useState<Record<string, unknown>>({});
	const [translation, setTranslation] = useState<Record<string, unknown>>({});
	const [languages, setLanguages] = useState<Array<{ name: string; tag: string }>>([]);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [loaded, setLoaded] = useState(false);

	const [textScale, setTextScaleState] = useState(() => {
		try {
			return Number.parseFloat(localStorage.getItem("pags:textScale") || "1") || 1;
		} catch {
			return 1;
		}
	});
	const setTextScale = (s: number) => {
		setTextScaleState(s);
		localStorage.setItem("pags:textScale", String(s));
		// "" (not "100%") at 1× so the stylesheet default wins again — matching what Profile did.
		document.documentElement.style.fontSize = s === 1 ? "" : `${s * 100}%`;
	};

	useEffect(() => {
		(async () => {
			try {
				const d = await api<{
					preferences?: { voice?: Record<string, unknown>; translation?: Record<string, unknown> };
					languages?: Array<{ name: string; tag: string }>;
				}>("/v1/preferences");
				setVoice(d.preferences?.voice || {});
				setTranslation(d.preferences?.translation || {});
				setLanguages(d.languages || []);
			} catch {
				// A failed read must still render the controls at platform defaults — an empty page
				// with no explanation is worse than editable defaults.
			}
			setLoaded(true);
		})();
		api<{ providers?: Record<string, boolean> }>("/v1/keys/status")
			.then((d) => setHasOpenAiKey(!!d.providers?.openai))
			.catch(() => setHasOpenAiKey(null));
	}, []);

	/** Section-level PATCH: sending only `voice` leaves stored translation untouched, and vice versa. */
	const saveVoice = useCallback(async (patch: Record<string, unknown>) => {
		const next = { ...voice, ...patch };
		setVoice(next);
		const d = await api<{ preferences?: { voice?: Record<string, unknown> } }>("/v1/preferences", {
			method: "PUT",
			body: JSON.stringify({ voice: next }),
		});
		if (d.preferences?.voice) setVoice(d.preferences.voice);
	}, [voice]);

	const saveTranslation = useCallback(async (next: Record<string, unknown>) => {
		setTranslation(next);
		await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ translation: next }) });
	}, []);

	return (
		<Page width={960}>
			<h2 className="text-xl font-bold mb-1">Preferences</h2>
			<p className="text-sm text-muted mb-5">
				How you speak, hear and read. These apply to <b>every</b> agent — any one of them can be
				customised on its own Settings tab.
			</p>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Appearance</h3>
				<div className="flex justify-between items-center py-2.5 text-sm">
					<span className="text-muted font-medium">Text size</span>
					<div className="inline-flex border border-line rounded-lg overflow-hidden">
						{[{ s: 0.9, l: "A-" }, { s: 1, l: "A" }, { s: 1.15, l: "A+" }, { s: 1.3, l: "A++" }].map(({ s, l }) => (
							<button
								key={s}
								type="button"
								onClick={() => setTextScale(s)}
								className={`px-2.5 py-1 text-xs font-bold ${textScale === s ? "bg-panel-hover text-ink" : "text-muted"}`}
							>
								{l}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>
				{loaded && <VoiceFields value={voice} onPatch={saveVoice} hasOpenAiKey={hasOpenAiKey} savedNote="Saved — applies to every agent" />}
			</div>

			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Translation</h3>
				{loaded && <TranslationFields value={translation} onSave={saveTranslation} languages={languages} />}
			</div>
		</Page>
	);
}
