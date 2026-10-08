/**
 * The Scout's scan schedule, where the owner can see and set it (#980).
 *
 * ── What it is, and what it deliberately is not
 *
 * It is a view and an editor of the ONE thing that actually fires a scan: a cron trigger with the
 * `run_local_browser` action (#962), swept by the platform's trigger cron. So the writes below go
 * to `/v1/triggers` — the same routes MCP's trigger tools use — rather than to a second scheduler
 * with its own rules to keep in step.
 *
 * It does NOT pick a cadence. A scan spends the owner's machine, their engine subscription and
 * whatever the sites they search make of the traffic, so the select below starts empty and
 * "Not scheduled" is a state this card is happy to keep showing (#980).
 */
import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import { CADENCE_OPTIONS, type ScanSchedule, cadenceLabel, scheduleHeadline, whenLabel } from "../../lib/scanSchedule";

const TONE: Record<"muted" | "success" | "warning" | "danger", string> = {
	muted: "text-muted",
	success: "text-success",
	warning: "text-warning",
	danger: "text-danger",
};

export default function ScanScheduleCard({ instanceId, schedule, onChanged, onScanNow }: { instanceId: string; schedule: ScanSchedule | null; onChanged: () => void; onScanNow: (objective: string) => void }) {
	const [cadence, setCadence] = useState(schedule?.cadence ?? "");
	const [objective, setObjective] = useState(schedule?.objective ?? "");
	const [busy, setBusy] = useState("");
	const [msg, setMsg] = useState("");
	const headline = scheduleHeadline(schedule);

	const act = async (what: string, run: () => Promise<unknown>) => {
		setBusy(what);
		setMsg("");
		try {
			await run();
			onChanged();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy("");
	};

	/** Create or update the cron trigger behind the schedule — one per Scout. */
	const save = () =>
		act("save", async () => {
			const body = { instanceId, type: "cron", action: "run_local_browser", name: "Scheduled scan", schedule: cadence, enabled: true, config: { objective: objective.trim() } };
			if (schedule?.triggerId) return api(`/v1/triggers/${encodeURIComponent(schedule.triggerId)}`, { method: "PUT", body: JSON.stringify(body) });
			return api("/v1/triggers", { method: "POST", body: JSON.stringify(body) });
		});

	const setEnabled = (enabled: boolean) =>
		act(enabled ? "enable" : "disable", () =>
			api(`/v1/triggers/${encodeURIComponent(schedule?.triggerId ?? "")}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
		);

	const remove = () =>
		act("remove", () => api(`/v1/triggers/${encodeURIComponent(schedule?.triggerId ?? "")}`, { method: "DELETE" }));

	return (
		<Card className="mb-3 sm:mb-4" data-testid="scan-schedule">
			<div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
				<h3 className="text-base font-bold">Scan schedule</h3>
				<span className={`text-xs font-semibold ${TONE[headline.tone]}`}>{headline.text}</span>
			</div>

			{schedule?.configured && (
				<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mb-3 sm:grid-cols-4">
					<div>
						<dt className="text-muted">Cadence</dt>
						<dd className="font-semibold">{cadenceLabel(schedule.cadence)}</dd>
					</div>
					<div>
						<dt className="text-muted">Next scan</dt>
						<dd className="font-semibold">{schedule.enabled ? whenLabel(schedule.nextRunAt) : "—"}</dd>
					</div>
					<div>
						<dt className="text-muted">Last scan</dt>
						<dd className="font-semibold">{whenLabel(schedule.lastRunAt)}</dd>
					</div>
					<div>
						<dt className="text-muted">Failures</dt>
						<dd className={`font-semibold ${schedule.failureCount ? "text-danger" : ""}`}>{schedule.failureCount}</dd>
					</div>
				</dl>
			)}

			<div className="flex flex-wrap items-end gap-2">
				<label className="text-xs text-muted flex flex-col gap-1">
					Cadence
					<select value={cadence} onChange={(e) => setCadence(e.target.value)} aria-label="Scan cadence" className="bg-paper border border-line rounded px-2 py-1.5 text-sm text-ink">
						{/* Empty FIRST and selected when nothing is configured: the platform proposes, the owner decides (#980). */}
						<option value="">Choose a cadence…</option>
						{CADENCE_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
						{schedule?.cadence && !CADENCE_OPTIONS.some((o) => o.value === schedule.cadence) && <option value={schedule.cadence}>{schedule.cadence}</option>}
					</select>
				</label>
				<label className="text-xs text-muted flex flex-col gap-1 flex-1 min-w-[14rem]">
					What each scheduled scan looks for
					<input
						value={objective}
						onChange={(e) => setObjective(e.target.value)}
						maxLength={4000}
						aria-label="Scheduled scan objective"
						placeholder="e.g. Senior TypeScript roles in Sydney posted this week"
						className="bg-paper border border-line rounded px-2 py-1.5 text-sm"
					/>
				</label>
				<Button variant="primary" disabled={!!busy || !cadence || !objective.trim()} onClick={save}>
					{busy === "save" ? "Saving…" : schedule?.configured ? "Update schedule" : "Schedule scans"}
				</Button>
				{schedule?.configured && (
					<>
						<Button disabled={!!busy} onClick={() => setEnabled(!schedule.enabled)}>
							{busy === "enable" || busy === "disable" ? "…" : schedule.enabled ? "Disable" : "Enable"}
						</Button>
						<Button disabled={!!busy} onClick={remove}>
							{busy === "remove" ? "…" : "Remove"}
						</Button>
					</>
				)}
				{/* The manual control #980 asks for, beside the schedule rather than only above it. */}
				<Button disabled={!!busy || !objective.trim()} onClick={() => onScanNow(objective.trim())}>
					Scan now
				</Button>
			</div>
			{schedule?.lastError && <p className="text-xs text-danger mt-2">Last attempt: {schedule.lastError}</p>}
			{msg && <p className="text-xs text-danger mt-2">{msg}</p>}
		</Card>
	);
}
