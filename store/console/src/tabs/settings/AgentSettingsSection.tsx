import type { SettingsField } from "../../lib/types";
import Card from "../../components/Card";

interface Props {
	agentFields: SettingsField[];
	agentSettings: Record<string, string | number | boolean>;
	settingsMsg: string;
	onSettingChange: (id: string, value: string | number | boolean) => void;
	onSaveSetting: (id: string, value: string | number | boolean) => Promise<void>;
}

export default function AgentSettingsSection({
	agentFields,
	agentSettings,
	settingsMsg,
	onSettingChange,
	onSaveSetting,
}: Props) {
	if (agentFields.length === 0) return null;

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Agent settings</h3>
			<p className="text-sm text-muted mb-3">Settings this agent understands. They apply to every conversation with it.</p>
			{agentFields.map((f) => {
				const controlId = `agent-setting-${f.id}`;
				return (
					<div key={f.id} className="mb-3">
						<label htmlFor={controlId} className="block text-sm font-semibold mb-1">
							{f.label}
						</label>
						{f.description && <p className="text-xs text-muted mb-1">{f.description}</p>}
						{f.type === "select" && (
							<select
								id={controlId}
								value={String(agentSettings[f.id] ?? "")}
								onChange={(e) => onSaveSetting(f.id, e.target.value)}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
							>
								{agentSettings[f.id] === undefined && <option value="">Choose…</option>}
								{(f.options || []).map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
						)}
						{f.type === "toggle" && (
							<label className="flex items-center gap-2 text-sm cursor-pointer">
								<input
									id={controlId}
									type="checkbox"
									checked={agentSettings[f.id] === true}
									onChange={(e) => onSaveSetting(f.id, e.target.checked)}
								/>
								<span className="text-muted">Enabled</span>
							</label>
						)}
						{f.type === "text" && (
							<input
								id={controlId}
								value={String(agentSettings[f.id] ?? "")}
								onChange={(e) => onSettingChange(f.id, e.target.value)}
								onBlur={(e) => onSaveSetting(f.id, e.target.value)}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-96"
							/>
						)}
						{f.type === "number" && (
							<input
								id={controlId}
								type="number"
								value={agentSettings[f.id] === undefined ? "" : Number(agentSettings[f.id])}
								onChange={(e) => onSettingChange(f.id, Number(e.target.value))}
								onBlur={(e) => {
									const n = Number(e.target.value);
									if (Number.isFinite(n)) onSaveSetting(f.id, n);
								}}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-40"
							/>
						)}
						{f.voiceLanguage && <p className="text-xs text-muted mt-1">Also sets the voice language for speech recognition and speaking.</p>}
					</div>
				);
			})}
			{settingsMsg && <div className="text-sm text-muted mt-1">{settingsMsg}</div>}
		</Card>
	);
}
