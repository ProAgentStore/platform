import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { fieldProblem, type MachineThresholds, type ThresholdKey, thresholdFields, thresholdsBody, verdictLine } from "../lib/machineThresholds";

interface Props {
	machineId: string;
}

/**
 * Admission thresholds (#1275): the session limit and the CPU / memory / disk lines the platform judges this machine
 * against before it starts a new session, shared by every agent that runs here. Each field shows the value in force and
 * whether this machine sets it; saving sends only what changed, and "Reset" returns every field to the defaults.
 * The API merges and enforces everything; this card sends the choice and draws what comes back.
 */
export default function MachineThresholdsCard({ machineId }: Props) {
	const [thresholds, setThresholds] = useState<MachineThresholds | null>(null);
	const [edited, setEdited] = useState<Partial<Record<ThresholdKey, string>>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const path = `/v1/terminals/machines/${encodeURIComponent(machineId)}/thresholds`;

	const load = useCallback(async () => {
		try {
			setThresholds(await api<MachineThresholds>(path));
			setEdited({});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load the thresholds.");
		}
	}, [path]);
	useEffect(() => {
		void load();
	}, [load]);

	const fields = thresholdFields(thresholds);
	const body = thresholdsBody(thresholds, edited);
	const problems = fields.map((f) => (edited[f.row.key] === undefined ? null : fieldProblem(f.row, edited[f.row.key] ?? ""))).filter((p): p is string => !!p);

	async function send(method: "PUT" | "DELETE", payload?: Record<string, number | null>) {
		setSaving(true);
		setError("");
		try {
			setThresholds(await api<MachineThresholds>(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) }));
			setEdited({});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save the thresholds.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card className="p-4" data-testid="machine-thresholds-settings">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="font-semibold text-sm">Admission thresholds</h2>
				{thresholds && <span className="text-xs text-muted" data-testid="machine-thresholds-verdict">{verdictLine(thresholds)}</span>}
			</div>
			<p className="text-sm text-muted mt-1">A new session is refused while this machine is over any line below, and starts again once it has been clear for a few samples. The limit and the lines are this machine's own — every agent that runs here shares them. A session already running is never touched.</p>

			<fieldset className="mt-3 grid gap-3 sm:grid-cols-2" disabled={saving || !thresholds}>
				{fields.map((f) => (
					<label key={f.row.key} className="block text-sm">
						<span className="flex items-center gap-2">
							{f.row.label}
							<span className="text-xs text-muted">({f.row.unit})</span>
							{f.overridden && <span className="text-xs text-accent" data-testid={`machine-threshold-overridden-${f.row.key}`}>set for this machine</span>}
						</span>
						<input
							className="mt-1 w-full rounded-lg border border-line bg-transparent px-2 py-1 text-sm"
							inputMode="decimal"
							value={edited[f.row.key] ?? f.value}
							onChange={(e) => setEdited({ ...edited, [f.row.key]: e.target.value })}
							data-testid={`machine-threshold-${f.row.key}`}
						/>
						<span className="block text-xs text-muted mt-0.5">{f.row.hint}{f.note ? ` (${f.note}.)` : ""}</span>
					</label>
				))}
			</fieldset>

			{problems.map((p) => (
				<p key={p} className="text-xs text-danger mt-2" role="alert">{p}</p>
			))}
			{error && <p className="text-xs text-danger mt-2" role="alert">{error}</p>}

			<div className="mt-3 flex gap-2">
				<Button onClick={() => void send("PUT", body)} disabled={saving || !Object.keys(body).length || problems.length > 0} data-testid="machine-thresholds-save">Save</Button>
				<Button variant="secondary" onClick={() => void send("DELETE")} disabled={saving || !thresholds || !Object.keys(thresholds.overrides).length} data-testid="machine-thresholds-reset">Reset to defaults</Button>
			</div>
		</Card>
	);
}
