import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { CLEANUP_MIN_CLI, type CleanupKey, type CleanupMode, checkboxes, cleanNowState, modeBody, overrideBody, reportLines, runnerSupportsCleanup } from "../lib/machineCleanup";
import { type MachineDetail, type MachineDetailResponse, machineFromResponse } from "../lib/machineDetail";

interface Props {
	machineId: string;
	machine: MachineDetail;
	onChange: (machine: MachineDetail) => void;
}

/**
 * Runner cleanup (#1265): one master toggle for the machine — gentle or harsh — and six checkboxes it sets the
 * defaults of, each overridable. Gentle touches only what the runner started; harsh is for a dedicated runner.
 * The API resolves and enforces everything; this card sends the choice and draws what comes back.
 */
export default function MachineCleanupCard({ machineId, machine, onChange }: Props) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const cleanup = machine.cleanup ?? null;
	const mode: CleanupMode = cleanup?.mode === "harsh" ? "harsh" : "gentle";
	const boxes = checkboxes(cleanup);
	const now = cleanNowState(cleanup);
	const lines = reportLines(cleanup?.report);

	async function send(body: Record<string, unknown>) {
		setSaving(true);
		setError("");
		try {
			const response = await api<MachineDetailResponse>(`/v1/terminals/machines/${encodeURIComponent(machineId)}/policy`, { method: "PUT", body: JSON.stringify(body) });
			if (response && typeof response === "object") onChange(machineFromResponse(response));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save the cleanup settings.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card className="p-4" data-testid="machine-cleanup-settings">
			<h2 className="font-semibold text-sm">Runner cleanup</h2>
			<p className="text-sm text-muted mt-1">After a run, the runner ends what the run started. Gentle touches only what it can prove it started — safe on a machine you also use. Harsh also sweeps orphaned build tools and prunes caches — for a dedicated runner. It never touches a live session, your own browser or uncommitted work.</p>

			{!runnerSupportsCleanup(machine.runnerVersion) && (
				<p className="text-xs text-warning mt-2" data-testid="machine-cleanup-too-old">
					This machine's runner (v{machine.runnerVersion}) predates cleanup (CLI {CLEANUP_MIN_CLI}). The settings are saved, but it will not act on them until it is updated.
				</p>
			)}

			<fieldset className="mt-3" disabled={saving}>
				<legend className="text-xs text-muted mb-1">Mode</legend>
				<div className="inline-flex rounded-lg border border-line overflow-hidden" role="radiogroup" aria-label="Cleanup mode">
					{(["gentle", "harsh"] as const).map((m) => (
						<label key={m} className={`px-3 py-1.5 text-sm cursor-pointer capitalize ${mode === m ? "bg-accent-soft text-ink font-semibold" : "text-muted hover:text-ink"}`}>
							<input type="radio" name="cleanup-mode" value={m} checked={mode === m} onChange={() => void send(modeBody(m))} className="sr-only" data-testid={`machine-cleanup-mode-${m}`} />
							{m}
						</label>
					))}
				</div>
				<p className="text-2xs text-muted-soft mt-1">Changing the mode resets the boxes below to its defaults.</p>
			</fieldset>

			<ul className="mt-3 flex flex-col gap-2" data-testid="machine-cleanup-behaviours">
				{boxes.map((b) => (
					<li key={b.key}>
						<label className="flex items-start gap-2 text-sm cursor-pointer">
							<input
								type="checkbox"
								className="mt-0.5"
								checked={b.checked}
								disabled={saving}
								onChange={(e) => void send(overrideBody(mode, b.key as CleanupKey, e.target.checked))}
								data-testid={`machine-cleanup-${b.key}`}
							/>
							<span className="min-w-0">
								{b.label}
								{b.overridden && <span className="ml-2 text-2xs text-warning">overridden for this machine</span>}
								<span className="block text-2xs text-muted-soft">{b.hint}</span>
							</span>
						</label>
					</li>
				))}
			</ul>

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button size="sm" disabled={saving || now.pending} onClick={() => void send({ cleanup_now: true })} data-testid="machine-cleanup-now">
					Clean now
				</Button>
				{now.text && <span role="status" className="text-xs text-muted" data-testid="machine-cleanup-now-state">{now.text}</span>}
			</div>

			{lines.length > 0 && (
				<ul className="mt-3 text-xs text-muted flex flex-col gap-0.5" data-testid="machine-cleanup-report">
					{lines.map((l) => <li key={l}>{l}</li>)}
				</ul>
			)}
			{cleanup?.report?.warnings.map((w) => <p key={w} className="text-xs text-warning mt-1">⚠ {w}</p>)}
			{saving && <p role="status" className="text-xs text-muted mt-2">Saving cleanup settings…</p>}
			{error && <p role="alert" className="text-xs text-danger mt-2">{error}</p>}
		</Card>
	);
}
