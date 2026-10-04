import PrefOverride from "../../components/PrefOverride";
import VoiceFields from "../../components/VoiceFields";
import TranslationFields from "../../components/TranslationFields";
import Card from "../../components/Card";
import { voiceSummary } from "../../lib/voiceSummary";

interface Props {
	instanceId: string;
	voiceSettings: Record<string, unknown> | null;
	voiceOverride: boolean;
	hasOpenAiKey: boolean | null;
	trLoaded: boolean;
	trOverride: boolean;
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
	onSetVoiceOverride: (value: boolean) => void;
	onSetTrOverride: (value: boolean) => void;
}

export default function VoiceTranslationSection({
	instanceId,
	voiceSettings,
	voiceOverride,
	hasOpenAiKey,
	trLoaded,
	trOverride,
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
	onSetVoiceOverride,
	onSetTrOverride,
}: Props) {
	return (
		<>
			{/* Voice — an OVERRIDE of account defaults (#211) */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>
				<PrefOverride
					label="voice settings"
					loaded={voiceSettings !== null}
					hasOverride={voiceOverride}
					summary={voiceSummary(voiceSettings, hasOpenAiKey)}
					onUseDefaults={onClearVoiceOverride}
					onCustomise={() => onSetVoiceOverride(true)}
				/>
				{voiceOverride && <VoiceFields value={voiceSettings || {}} onPatch={onSaveVoice} hasOpenAiKey={hasOpenAiKey} />}
			</Card>

			{/* Translation — same override contract as Voice */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Translation</h3>
				<PrefOverride
					label="translation settings"
					loaded={trLoaded}
					hasOverride={trOverride}
					summary={trEnabled ? `On — ${trTarget}` : "Off"}
					onUseDefaults={onClearTrOverride}
					onCustomise={() => onSetTrOverride(true)}
				/>
				{trOverride && (
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
				)}
			</Card>
		</>
	);
}
