import { useState } from "react";

/** A local draft avoids saving half-entered numbers or changing active runs. */
export default function ApplicationCommandTimeoutSettings({ value = 600, busy, onChange }: {
	value?: number;
	busy: boolean;
	onChange: (patch: { browserCommandTimeoutSeconds: number }) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	const seconds = Number(draft);
	const valid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600;
	return <div className="mb-4">
		<label className="flex flex-col gap-1 text-sm">
			<span className="font-semibold">Browser command timeout (seconds)</span>
			<input type="number" min={1} max={3600} step={1} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} className="bg-paper border border-line rounded px-2 py-1 text-sm" />
		</label>
		<p className="text-xs text-muted mt-1">Default 600 seconds. Choose 1–3600 seconds for each browser command. Changes apply to new runs. A timeout does not cancel an action; the browser waits for recovery before more commands.</p>
		<button type="button" disabled={busy || !valid || seconds === value} onClick={() => onChange({ browserCommandTimeoutSeconds: seconds })} className="text-sm underline mt-1">Save command timeout</button>
	</div>;
}
