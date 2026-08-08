import { useState } from "react";
import { Link } from "react-router-dom";

/**
 * "Using your defaults / Customise for this agent" — ONE control per section (#211).
 *
 * One toggle per SECTION, deliberately not one per field. A per-field override control would
 * re-create exactly the per-agent settings sprawl this change exists to remove: the point is that
 * you configure your voice once, and an agent is either following that or it isn't.
 *
 * The state shown is PRESENCE of an override, not whether the values happen to differ. An override
 * that coincidentally matches your defaults is still a choice the user made, and flipping the radio
 * back on them because the numbers agree would be the UI arguing with them.
 */
export interface PrefOverrideProps {
	/** What is being overridden, lower-case, e.g. "voice settings". Used in the labels. */
	label: string;
	hasOverride: boolean;
	/** One-line description of the effective values, shown next to "Using your defaults". */
	summary?: string;
	/**
	 * False until the current value has loaded.
	 *
	 * Load-bearing, not cosmetic: the initial GET resolves asynchronously and then sets the
	 * override state. Clicking before it lands means the fetch's answer overwrites the choice you
	 * just made, and the radio silently springs back. A control whose current value is unknown
	 * must not be operable.
	 */
	loaded?: boolean;
	/**
	 * May reject. Clearing an override is a DELETE, and this radio is the only thing that reports
	 * whether it landed: the caller must not flip `hasOverride` optimistically, because a failed
	 * DELETE leaves the override live on the server while the screen says "using your defaults" —
	 * and then prints the OVERRIDE's own values as the summary of the account defaults, so the two
	 * halves of the lie corroborate each other. Reject and the radio stays where it truthfully is.
	 */
	onUseDefaults: () => void | Promise<void>;
	onCustomise: () => void;
}

export default function PrefOverride({ label, hasOverride, summary, loaded = true, onUseDefaults, onCustomise }: PrefOverrideProps) {
	const name = `pref-${label.replace(/\s+/g, "-")}`;
	const [error, setError] = useState("");
	// The failure belongs to the control, not to the page: this component owns the radio whose
	// position is the claim, so it is the one place that can say the claim did not take.
	const useDefaults = async () => {
		setError("");
		try {
			await onUseDefaults();
		} catch {
			setError(`Couldn't switch to your defaults — this agent is still using its own ${label}.`);
		}
	};
	if (!loaded) {
		return <div className="mb-3 text-sm text-muted-soft">Loading your {label}…</div>;
	}
	return (
		<div className="mb-3">
			<label className="flex items-start gap-2 text-sm cursor-pointer py-1">
				<input type="radio" name={name} checked={!hasOverride} onChange={useDefaults} className="mt-0.5" />
				<span className="min-w-0">
					<span className="font-semibold">Using your defaults</span>
					{summary && <span className="text-muted"> — {summary}</span>}
					<span className="block text-xs text-muted-soft">
						Set once for every agent in <Link to="/preferences" className="underline">Preferences</Link>.
					</span>
				</span>
			</label>
			<label className="flex items-start gap-2 text-sm cursor-pointer py-1">
				<input type="radio" name={name} checked={hasOverride} onChange={onCustomise} className="mt-0.5" />
				<span className="min-w-0">
					<span className="font-semibold">Customise for this agent</span>
					<span className="block text-xs text-muted-soft">
						Only this agent uses the {label} below; every other agent keeps your defaults.
					</span>
				</span>
			</label>
			{error && <p className="text-xs text-danger mt-1">{error}</p>}
		</div>
	);
}
