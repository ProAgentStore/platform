export type BrowserMode = "headed" | "headless";

export function browserModeLabel(mode: BrowserMode | null): string {
	return mode === "headed" ? "Visible browser" : mode === "headless" ? "Headless browser" : "Runner default";
}

export default function BrowserModeSelect({ value, inheritLabel, disabled, onChange }: {
	value: BrowserMode | null;
	inheritLabel: string;
	disabled?: boolean;
	onChange: (mode: BrowserMode | null) => void;
}) {
	return (
		<label className="flex flex-col gap-1 text-sm font-semibold">
			Browser mode
			<select className="bg-paper border border-line rounded px-2 py-1 text-sm font-normal w-full sm:max-w-sm" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "headed" || e.target.value === "headless" ? e.target.value : null)}>
				<option value="">{inheritLabel}</option>
				<option value="headed">Visible browser</option>
				<option value="headless">Headless browser</option>
			</select>
		</label>
	);
}
