import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import VoiceFields from "../../components/VoiceFields";
import TranslationFields from "../../components/TranslationFields";
import Card from "../../components/Card";
import { voiceSummary } from "../../lib/voiceSummary";
import {
	OVERRIDE_ACTION,
	PREFERENCES_LINK,
	USE_ACCOUNT_DEFAULT,
	type OverrideLoad,
	overrideLineText,
	overrideState,
} from "../../lib/overrideLine";

interface Props {
	voiceSettings: Record<string, unknown> | null;
	voiceLoad: OverrideLoad;
	voiceOverride: boolean;
	voiceRevealed: boolean;
	hasOpenAiKey: boolean | null;
	trLoad: OverrideLoad;
	trOverride: boolean;
	trRevealed: boolean;
	trEnabled: boolean;
	trTarget: string;
	trTranslit: boolean;
	trWordTap: boolean;
	trFontSize: string;
	trLanguages: Array<{ name: string; tag: string }>;
	onSaveVoice: (patch: Record<string, unknown>) => Promise<void>;
	onClearVoiceOverride: () => Promise<void>;
	onSaveTranslationOverride: (next: {
		enabled: boolean;
		target: string;
		transliterate: boolean;
		wordTap: boolean;
		fontSize: string;
	}) => Promise<void>;
	onClearTrOverride: () => Promise<void>;
	onSetVoiceRevealed: (value: boolean) => void;
	onSetTrRevealed: (value: boolean) => void;
}

const BTN = "min-h-6 min-w-6 underline text-sm font-semibold inline-flex items-center";

/**
 * One row: a single line that follows the account, or (revealed / overridden) the form below it.
 * Clearing an override is a DELETE, so a rejection is reported here and the form stays where it
 * truthfully is, rather than flipping to "follows your account" while the override is still live.
 */
function OverrideRow({
	name,
	label,
	load,
	hasOverride,
	revealed,
	summary,
	onReveal,
	onCancel,
	onUseDefault,
	testId,
	children,
}: {
	name: "Voice" | "Translation";
	label: string;
	load: OverrideLoad;
	hasOverride: boolean;
	revealed: boolean;
	summary: string;
	onReveal: () => void;
	onCancel: () => void;
	onUseDefault: () => Promise<void>;
	testId: string;
	children: ReactNode;
}) {
	const [error, setError] = useState("");
	const state = overrideState({ load, hasOverride, revealed });
	const useDefault = async () => {
		setError("");
		try {
			await onUseDefault();
		} catch {
			setError(`Couldn't switch to your account default — this agent is still using its own ${label}.`);
		}
	};
	if (state === "revealed" || state === "overridden") {
		return (
			<Card className="mb-3 sm:mb-4" data-testid={testId}>
				<h3 className="text-base font-bold mb-2">{name}</h3>
				{children}
				<div className="mt-2">
					{state === "revealed" ? (
						<button type="button" onClick={onCancel} className={BTN}>Cancel</button>
					) : (
						<button type="button" onClick={useDefault} className={BTN}>{USE_ACCOUNT_DEFAULT}</button>
					)}
				</div>
				{error && <p className="text-xs text-danger mt-1">{error}</p>}
			</Card>
		);
	}
	const lineState = state;
	return (
		<p role="status" data-testid={testId} className="text-sm mb-3 flex flex-wrap items-center gap-x-1 min-h-6">
			<span className={lineState === "line" ? "" : "text-muted"}>{overrideLineText(name, lineState, summary)}</span>
			{lineState === "line" && (
				<>
					<span className="text-muted" aria-hidden="true">·</span>
					<Link to="/preferences" className="underline min-h-6 inline-flex items-center">{PREFERENCES_LINK}</Link>
					<span className="text-muted" aria-hidden="true">·</span>
					<button type="button" onClick={onReveal} className={BTN}>{OVERRIDE_ACTION}</button>
				</>
			)}
		</p>
	);
}

export default function VoiceTranslationSection({
	voiceSettings,
	voiceLoad,
	voiceOverride,
	voiceRevealed,
	hasOpenAiKey,
	trLoad,
	trOverride,
	trRevealed,
	trEnabled,
	trTarget,
	trTranslit,
	trWordTap,
	trFontSize,
	trLanguages,
	onSaveVoice,
	onClearVoiceOverride,
	onSaveTranslationOverride,
	onClearTrOverride,
	onSetVoiceRevealed,
	onSetTrRevealed,
}: Props) {
	return (
		<>
			{/* Voice — an OVERRIDE of account defaults (#211); the console has no voice capability, so always shown */}
			<OverrideRow
				name="Voice"
				label="voice settings"
				load={voiceLoad}
				hasOverride={voiceOverride}
				revealed={voiceRevealed}
				summary={voiceSummary(voiceSettings, hasOpenAiKey)}
				onReveal={() => onSetVoiceRevealed(true)}
				onCancel={() => onSetVoiceRevealed(false)}
				onUseDefault={onClearVoiceOverride}
				testId="voice-override"
			>
				<VoiceFields value={voiceSettings || {}} onPatch={onSaveVoice} hasOpenAiKey={hasOpenAiKey} />
			</OverrideRow>

			{/* Translation — same override contract as Voice */}
			<OverrideRow
				name="Translation"
				label="translation settings"
				load={trLoad}
				hasOverride={trOverride}
				revealed={trRevealed}
				summary={trEnabled ? trTarget : "off"}
				onReveal={() => onSetTrRevealed(true)}
				onCancel={() => onSetTrRevealed(false)}
				onUseDefault={onClearTrOverride}
				testId="translation-override"
			>
				<TranslationFields
					value={{
						enabled: trEnabled,
						target: trTarget,
						transliterate: trTranslit,
						wordTap: trWordTap,
						fontSize: trFontSize,
					}}
					onSave={onSaveTranslationOverride}
					languages={trLanguages}
				/>
			</OverrideRow>
		</>
	);
}
