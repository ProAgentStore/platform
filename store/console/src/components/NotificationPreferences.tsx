import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "./Card";

/** One row of the vocabulary, as `GET /v1/preferences` serves it. */
export interface NotificationTypeSpec {
	id: string;
	label: string;
	description: string;
	/** True when this type can ALSO raise a request for your input, which a mute never hides. */
	alerts: boolean;
}

/**
 * Which notifications may interrupt you (#360).
 *
 * Push had no per-type preference of ANY kind: the routes were subscribe, unsubscribe and test.
 * A user who found deploy notifications noisy had exactly one remedy — turn push off entirely,
 * which also loses the CAPTCHA handoff, the one notification the product genuinely needs to
 * interrupt for. The vocabulary to say "mute deploys, keep handoffs" was already in the payload
 * as the push `tag`; it simply had no control attached.
 *
 * It lives on Preferences, not on an agent's Settings tab, because push subscriptions are
 * per-ACCOUNT and `sendPushToUser` fans out to every device the user has. Muting a class of
 * notification is not a property of one agent, and it cannot be a property of one browser —
 * which is also why #176's visibility gate cannot cover this: that is a per-device decision made
 * by each device's own service worker, so the laptop you are looking at goes quiet and the phone
 * in your pocket does not.
 *
 * **The mute never hides a request for your input.** That is stated in the section header rather
 * than discovered later, and the per-row note repeats it for the mixed types, because the cost of
 * getting this wrong is asymmetric: an unwanted buzz is an annoyance, while a silenced handoff is
 * a run that stops and never says so, indistinguishable from an agent being slow.
 *
 * The list is a `.map()` over the server's table — a new notification type gets a control by
 * being added to `workers/api/src/lib/notifications.ts`, not by editing this file.
 */
export default function NotificationPreferences({
	types,
	muted,
	onSaved,
}: {
	types: NotificationTypeSpec[];
	muted: string[];
	onSaved: (muted: string[]) => void;
}) {
	const [local, setLocal] = useState<string[]>(muted);
	const [msg, setMsg] = useState("");

	// The parent owns the stored value; re-sync when it finishes loading or another save lands.
	useEffect(() => setLocal(muted), [muted]);

	const toggle = useCallback(
		async (id: string, notify: boolean) => {
			const next = notify ? local.filter((m) => m !== id) : [...new Set([...local, id])];
			const previous = local;
			setLocal(next);
			setMsg("");
			try {
				await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ notifications: { muted: next } }) });
				onSaved(next);
			} catch {
				// Put the control back rather than showing a save that did not happen — the same rule
				// the timezone control follows, and it matters more here: a checkbox that looks off
				// while the notifications keep arriving reads as the notification system being broken.
				setLocal(previous);
				setMsg("Couldn't save that. Try again.");
			}
		},
		[local, onSaved],
	);

	if (!types.length) return null;

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Notifications</h3>
			<p className="text-xs text-muted mb-3">
				Which updates may reach your phone. Applies to <b>every</b> device you have enabled alerts
				on, because a push goes to your account rather than to one browser.{" "}
				<b>An agent waiting on you always gets through</b> — turning something off here stops the
				news, never a run that has stopped and needs an answer. Everything stays in this list
				either way.
			</p>

			{types.map((t) => {
				const on = !local.includes(t.id);
				return (
					<label
						key={t.id}
						className="flex items-start justify-between gap-3 py-2.5 border-t border-line first:border-t-0 cursor-pointer"
					>
						<span className="text-sm min-w-0">
							<span className="font-semibold">{t.label}</span>
							<span className="block text-[0.7rem] text-muted-soft mt-0.5">
								{t.description}
								{t.alerts && !on ? " Requests for your input still come through." : ""}
							</span>
						</span>
						<input
							type="checkbox"
							checked={on}
							onChange={(e) => void toggle(t.id, e.target.checked)}
							aria-label={`Notify me about ${t.label}`}
							className="mt-0.5 shrink-0 w-4 h-4 accent-accent"
						/>
					</label>
				);
			})}

			{msg && <p className="text-xs text-red mt-2">{msg}</p>}
		</Card>
	);
}
