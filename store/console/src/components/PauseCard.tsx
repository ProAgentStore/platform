import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { pausePanel, type PauseResponse } from "../lib/instancePause";

/**
 * The reversible lifecycle control (#825) — Pause, or Resume when it is already paused.
 *
 * Its own component rather than more JSX in `SettingsTab`, for two reasons that both showed up
 * when it was inline. The tab crossed the 800-line ratchet the moment this landed, and the guard's
 * own advice is that splitting is cheapest at that moment; and the handler below is three pieces
 * of state that exist only for this card, which is the definition of something that belongs
 * beside its own markup.
 *
 * It owns the status it renders. `SettingsTab` hands over what the roster read already knew and
 * then stops caring: nothing else on that page changes behaviour when an instance is paused, so a
 * second holder of this value would be a second thing to keep in step for no reader.
 */
export default function PauseCard({ instanceId, initialStatus }: { instanceId: string; initialStatus: string | null }) {
	const [status, setStatus] = useState<string | null>(initialStatus);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const panel = pausePanel(status);

	/**
	 * The two paths are written out in full rather than interpolated from `panel.action`.
	 *
	 * A template segment the parity extractor cannot resolve is reported as one unmeasurable
	 * capability `POST /v1/instances/{}/{}` — so `check-mcp-parity.mjs` could not see that
	 * `pause_instance` and `resume_instance` cover these, and failed on a gap that does not exist.
	 * Two literals cost a branch and keep the measurement true, which is the same reason that
	 * script's own header gives for declining to guess at a computed method.
	 */
	const toggle = async () => {
		setBusy(true);
		setMsg("");
		try {
			const d =
				panel.action === "pause"
					? await api<PauseResponse>(`/v1/instances/${instanceId}/pause`, { method: "POST" })
					: await api<PauseResponse>(`/v1/instances/${instanceId}/resume`, { method: "POST" });
			// From the RESPONSE, never from which button was pressed: the routes are idempotent and
			// answer `changed:false` when the state already held, so trusting the press would show
			// "Resume" after a pause that was already in effect.
			setStatus(d.status ?? null);
			const asked = d.runsAskedToStop ?? 0;
			setMsg(
				panel.action === "resume"
					? "Resumed — this agent can start work again."
					: asked > 0
						// "Asked to stop", never "stopped": a run ends at the top of its next
						// iteration, so reporting a cooperative signal as a kill would over-claim.
						? `Paused — ${asked} run${asked === 1 ? "" : "s"} asked to stop. They finish their current step first.`
						: "Paused. No runs were in flight.",
			);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">{panel.title}</h3>
			<p className="text-sm text-muted mb-3" id="inst-pause-statement">{panel.statement}</p>
			<Button onClick={toggle} disabled={busy}>{panel.button}</Button>
			{msg && <p className="text-xs text-muted mt-2" id="inst-pause-msg">{msg}</p>}
		</Card>
	);
}
