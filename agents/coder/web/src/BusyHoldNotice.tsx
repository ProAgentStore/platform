import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { api } from "@proagentstore/sdk/client";
import { BUSY_HOLD_STOPPING, type BusyHold, busyHoldLink, busyHoldNotice, busyHoldRunsLink, busyHoldStopPath } from "./coding-loop-run";

/**
 * A busy refusal, said to a human (#931): what holds the repo, a link to that run's live view, and
 * a Stop for it — the two things the agent-facing sentence ("stop it first with stop_work") offered
 * no button for. Rendered by both live loop watchers: this tab and the console's Assistant tab.
 */
export default function BusyHoldNotice({ instanceId, hold, onDismiss }: { instanceId: string; hold: BusyHold; onDismiss: () => void }) {
	const runLink = busyHoldLink(instanceId, hold);
	const stopPath = busyHoldStopPath(instanceId, hold);
	const [stop, setStop] = useState<{ state: "idle" | "sending" | "sent" } | { state: "failed"; error: string }>({ state: "idle" });
	const requestStop = async () => {
		if (!stopPath) return;
		setStop({ state: "sending" });
		try {
			await api(stopPath, { method: "POST" });
			setStop({ state: "sent" });
		} catch (e) {
			setStop({ state: "failed", error: e instanceof Error ? e.message : String(e) });
		}
	};
	return (
		<div role="alert" data-testid="busy-hold" className="flex items-start gap-2 px-3 py-2 text-xs border border-warning bg-warning-soft text-warning rounded-lg">
			<div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
				<p>{stop.state === "sent" ? BUSY_HOLD_STOPPING : busyHoldNotice(hold)}</p>
				{hold.run && stop.state !== "sent" && (
					<p className="mt-1 flex flex-wrap items-center gap-x-3 font-semibold">
						{runLink && <Link to={runLink} data-testid="busy-hold-open" className="underline hover:no-underline">Open the running loop</Link>}
						<button type="button" onClick={requestStop} disabled={stop.state === "sending"} data-testid="busy-hold-stop" className="underline hover:no-underline disabled:opacity-60">{stop.state === "sending" ? "Stopping…" : "Stop it"}</button>
						<Link to={busyHoldRunsLink(instanceId)} className="underline hover:no-underline">All runs</Link>
					</p>
				)}
				{stop.state === "failed" && <p className="mt-1 text-danger">Couldn't stop it: {stop.error}</p>}
			</div>
			<button type="button" onClick={onDismiss} aria-label="Dismiss" className="tap-target opacity-70 hover:opacity-100"><X size={13} /></button>
		</div>
	);
}
