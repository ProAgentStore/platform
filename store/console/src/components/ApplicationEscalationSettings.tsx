import type { ApplicationRunnerSettingsView } from "../lib/types";

type EscalationLevel = ApplicationRunnerSettingsView["settings"]["escalationLevel"];
type EscalationPatch = Pick<ApplicationRunnerSettingsView["settings"], "escalationLevel">;

/** Only this policy changes; selecting autonomy never enables submission. */
export default function ApplicationEscalationSettings({ value, busy, onChange }: {
	value?: EscalationLevel;
	busy: boolean;
	onChange: (patch: EscalationPatch) => void;
}) {
	return (
		<div className="mb-4">
			<label className="flex flex-col gap-1 text-sm">
				<span className="font-semibold">Application Runner escalation level</span>
				<select
					value={value ?? "conservative"}
					disabled={busy}
					onChange={(event) => onChange({ escalationLevel: event.target.value as EscalationLevel })}
					className="bg-paper border border-line rounded px-2 py-1 text-sm w-full"
				>
					<option value="conservative">Conservative — ask on uncertain minor and major judgments</option>
					<option value="balanced">Balanced — model handles minor judgments; asks on major judgments</option>
					<option value="autonomous">Autonomous — model handles minor and major judgments</option>
				</select>
			</label>
			<p className="text-xs text-muted mt-1">
				The model assesses whether a judgment is minor or major. Higher autonomy accepts the risk of its source-supported decisions without asking you first. Unknown personal facts remain unresolved; the model cannot invent them.
			</p>
			<p className="text-xs text-muted mt-1">
				Changes save immediately for new runs. Submission permission is configured separately below. Stop, credential and website restrictions still apply; this setting does not remove technical blockers or guarantee completion.
			</p>
		</div>
	);
}
