import { useEffect, useState } from "react";

/**
 * The translation controls, rendered identically by the account Preferences page and by a per-agent
 * override on the instance Settings tab (#211). Sibling of VoiceFields — same contract, same reason.
 */
export interface TranslationFieldsProps {
	value: { enabled?: boolean; target?: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string };
	/** Persist the whole section (the API takes a complete translation object). */
	onSave: (next: { enabled: boolean; target: string; transliterate: boolean; wordTap: boolean; fontSize: string }) => Promise<unknown>;
	/** Target languages the platform can gloss into. */
	languages: Array<{ name: string; tag: string }>;
}

export default function TranslationFields({ value, onSave, languages }: TranslationFieldsProps) {
	const [trEnabled, setTrEnabled] = useState(false);
	const [trTarget, setTrTarget] = useState("English");
	const [trTranslit, setTrTranslit] = useState(false);
	const [trWordTap, setTrWordTap] = useState(true);
	const [trFontSize, setTrFontSize] = useState("medium");
	const [trMsg, setTrMsg] = useState("");
	const trLanguages = languages;

	useEffect(() => {
		setTrEnabled(value?.enabled === true);
		setTrTarget(value?.target || "English");
		setTrTranslit(value?.transliterate === true);
		setTrWordTap(value?.wordTap !== false);
		setTrFontSize(value?.fontSize || "medium");
	}, [value]);

	const saveTranslation = async (enabled: boolean, target: string, transliterate: boolean, wordTap: boolean, fontSize: string) => {
		setTrEnabled(enabled); setTrTarget(target); setTrTranslit(transliterate); setTrWordTap(wordTap); setTrFontSize(fontSize);
		try {
			await onSave({ enabled, target, transliterate, wordTap, fontSize });
			setTrMsg("Saved");
			setTimeout(() => setTrMsg(""), 2000);
		} catch (e) {
			setTrMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	return (
		<>
			<p className="text-sm text-muted mb-3">
				Show a translation beneath each of the agent's replies — useful when it chats with you in a language you're learning. The agent stops translating inline; the platform does it instead.
			</p>
			<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
				<input
					type="checkbox"
					checked={trEnabled}
					onChange={(e) => saveTranslation(e.target.checked, trTarget, trTranslit, trWordTap, trFontSize)}
				/>
				<span className="text-muted">Show translation under replies</span>
			</label>
			{trEnabled && (
				<>
					<label htmlFor="translation-target" className="block text-xs font-semibold mb-1">Translate into</label>
					<select
						id="translation-target"
						value={trTarget}
						onChange={(e) => saveTranslation(true, e.target.value, trTranslit, trWordTap, trFontSize)}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
					>
						{(trLanguages.length ? trLanguages : [{ name: trTarget, tag: "" }]).map((l) => (
							<option key={l.name} value={l.name}>{l.name}</option>
						))}
					</select>
					<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
						<input
							type="checkbox"
							checked={trTranslit}
							onChange={(e) => saveTranslation(true, trTarget, e.target.checked, trWordTap, trFontSize)}
						/>
						<span className="text-muted">Also show transliteration (pinyin / romaji / romanization)</span>
					</label>
					<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
						<input
							type="checkbox"
							checked={trWordTap}
							onChange={(e) => saveTranslation(true, trTarget, trTranslit, e.target.checked, trFontSize)}
						/>
						<span className="text-muted">Tap a word to hear it pronounced (long-press still selects text)</span>
					</label>
					<label htmlFor="translation-text-size" className="block text-xs font-semibold mb-1">Text size</label>
					<select
						id="translation-text-size"
						value={trFontSize}
						onChange={(e) => saveTranslation(true, trTarget, trTranslit, trWordTap, e.target.value)}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
					>
						<option value="small">Small</option>
						<option value="medium">Medium</option>
						<option value="large">Large</option>
					</select>
				</>
			)}
			{trMsg && <div className="text-sm text-muted mt-2">{trMsg}</div>}
		</>
	);
}
