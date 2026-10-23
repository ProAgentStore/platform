import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import { type CalendarGrant, type CalendarGrantListResponse, type CalendarGrantResponse, type CalendarStatus, calendarStateLine } from "../lib/calendarState";

interface Props {
	instanceId: string;
}

/**
 * Google Calendar for one agent (#1313). The account connection is the owner's; each grant here names
 * ONE exact calendar id, typed rather than picked, because a calendar visible to the account is not a
 * calendar this agent should have. The agent can only read events on a calendar listed here.
 */
export function CalendarConnectorPanel({ instanceId }: Props) {
	const [status, setStatus] = useState<CalendarStatus | null>(null);
	const [grants, setGrants] = useState<CalendarGrant[]>([]);
	const [calendarId, setCalendarId] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			setStatus(await api<CalendarStatus>("/v1/calendar/status?check=1"));
		} catch {
			setStatus({ access: "error", account: null, accounts: 0, message: "Google Calendar's state could not be loaded.", checked: false, reach: { grants: 0, instances: 0 } });
		}
		try {
			setGrants((await api<CalendarGrantListResponse>(`/v1/calendar/instances/${instanceId}/grants`)).grants);
		} catch {
			setError("This agent's calendar grants could not be loaded.");
		}
	}, [instanceId]);

	useEffect(() => {
		void load();
	}, [load]);

	const state = calendarStateLine(status);

	const grant = async () => {
		const id = calendarId.trim();
		if (!id) return;
		setSaving(true);
		setError("");
		setMessage("");
		try {
			const d = await api<CalendarGrantResponse>(`/v1/calendar/instances/${instanceId}/grants`, { method: "POST", body: JSON.stringify({ calendarId: id }) });
			setGrants((gs) => [d.grant, ...gs.filter((g) => g.id !== d.grant.id)]);
			setMessage(`Granted this agent read-only access to ${d.grant.resourceName}.`);
			setCalendarId("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not grant this calendar.");
		} finally {
			setSaving(false);
		}
	};

	const remove = async (g: CalendarGrant) => {
		setError("");
		try {
			await api(`/v1/calendar/instances/${instanceId}/grants/${g.id}`, { method: "DELETE" });
			setGrants((gs) => gs.filter((x) => x.id !== g.id));
			setMessage(`Removed access to ${g.resourceName}.`);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not remove this calendar grant.");
		}
	};

	return (
		<div className="mb-4" data-testid="calendar-connector-panel">
			<div className="text-sm mb-2">
				<span className="font-semibold">Google Calendar</span>
				<p className="text-2xs text-muted-soft mt-0.5">Exact calendars this agent may read events from. Read-only: it cannot create, change or delete events, and it cannot see any calendar not listed here.</p>
			</div>
			<div className="pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
				<p className={`text-xs mb-2 ${state.tone === "ok" ? "text-success" : state.tone === "warn" ? "text-danger" : "text-muted"}`} data-testid="calendar-connection-state">{state.text}</p>
				<div className="flex gap-2 flex-wrap mb-2">
					<input aria-label="Exact Google calendar id to grant this agent" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="calendar id, e.g. betabuilders.org@gmail.com" className="flex-1 min-w-0 sm:min-w-[12rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<Button onClick={() => void grant()} disabled={!calendarId.trim() || saving || !state.canGrant}>
						Grant calendar
					</Button>
				</div>
				{error && <p className="text-xs text-danger mb-2">{error}</p>}
				{message && <p className="text-xs text-muted mb-2">{message}</p>}
				<div className="flex flex-col gap-1.5">
					{grants.length === 0 ? <p className="text-xs text-muted">No calendars granted to this agent yet.</p> : grants.map((g) => (
						<div key={g.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
							<span className="min-w-0 truncate">{g.resourceName}{g.resourceName !== g.resourceId ? ` (${g.resourceId})` : ""}</span>
							<button type="button" onClick={() => void remove(g)} className="shrink-0 text-muted hover:text-danger">Remove</button>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
