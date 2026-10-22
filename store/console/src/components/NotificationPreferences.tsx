import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { NotificationsEdit } from "../lib/notificationsStore";
import { toggledScope } from "../lib/notificationsStore";
import type { AttentionEventSpec, Instance, NotificationTypeSpec } from "../lib/types";
import Card from "./Card";

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
	instances,
	onEdit,
	ready,
	storeError,
	attentionEvents,
	pushOff,
	onPushOffSaved,
}: {
	types: ReadonlyArray<NotificationTypeSpec>;
	/**
	 * The muted types, from the page's ONE notifications store (#1283) — not a copy held here. The store writes the whole
	 * `notifications` section (mutes, scope AND rules) on every change, so toggling a switch cannot erase a rule.
	 */
	muted: string[];
	/**
	 * The instance scope (#784): ids whose updates may interrupt you; empty means every instance.
	 * Per ACCOUNT like the mute above, and for the same reason — a push fans out to every device.
	 */
	instances: string[];
	/** Apply one change to the shared store and write the whole section. Resolves to whether the server confirmed it. */
	onEdit: (edit: NotificationsEdit) => Promise<boolean>;
	/** False until the stored settings have loaded: a write before then would overwrite them with defaults. */
	ready: boolean;
	/** Why the last notifications write (or the first read) failed, or "". */
	storeError: string;
	/**
	 * The owner-attention vocabulary (#991) — the KINDS of attention an agent can ask for, which is
	 * a different axis from the product-area mutes above. Served by the route, mapped here, so a new
	 * event gets its control from `lib/owner-attention.ts`.
	 */
	attentionEvents: ReadonlyArray<AttentionEventSpec>;
	pushOff: string[];
	onPushOffSaved: (pushOff: string[]) => void;
}) {
	// `muted` and `instances` are shown straight from the shared store, so a refused save puts them back by itself.
	const local = muted;
	const scope = instances;
	const [quiet, setQuiet] = useState<string[]>(pushOff);
	const [roster, setRoster] = useState<Pick<Instance, "id" | "name" | "slug">[] | null>(null);
	const [msg, setMsg] = useState("");

	// The parent owns the stored value; re-sync when it finishes loading or another save lands.
	useEffect(() => setQuiet(pushOff), [pushOff]);

	/**
	 * Turn one KIND of attention's push off — "don't buzz me when something needs approving",
	 * whichever agent asks. Its own section on the route, so the mutes and the scope above are not
	 * resent and cannot be clobbered by a save made in another tab.
	 */
	const toggleAttention = useCallback(
		async (id: string, notify: boolean) => {
			const next = notify ? quiet.filter((q) => q !== id) : [...new Set([...quiet, id])];
			const previous = quiet;
			setQuiet(next);
			setMsg("");
			try {
				await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ attention: { pushOff: next } }) });
				onPushOffSaved(next);
			} catch {
				setQuiet(previous);
				setMsg("Couldn't save that. Try again.");
			}
		},
		[quiet, onPushOffSaved],
	);

	// The instances the scope can name. Read once; a scope entry for an instance that is gone is
	// simply not shown, and the server drops nothing on read, so it is harmless either way.
	useEffect(() => {
		api<{ instances: Instance[] }>("/v1/instances/my/instances")
			.then((d) => setRoster((d.instances || []).map(({ id, name, slug }) => ({ id, name, slug }))))
			.catch(() => setRoster([]));
	}, []);

	/**
	 * "Notify me about this agent" per instance. The stored shape is a LIST of the instances that
	 * may interrupt, absent for "all" — so ticking every box (or the last unticked one) clears the
	 * scope rather than storing a list that happens to be complete, and unticking the last box is
	 * refused: an empty scope would read back as "all", the opposite of what was asked. The per-type
	 * controls above are how to silence everything.
	 */
	const toggleInstance = useCallback(
		async (id: string, notify: boolean) => {
			if (!roster) return;
			const all = roster.map((r) => r.id);
			if (toggledScope(scope, id, notify, all) === null) {
				setMsg("At least one agent has to stay on — use the switches above to silence a kind of update everywhere.");
				return;
			}
			setMsg("");
			// The store writes the whole section (mutes, this scope and the rules) and puts the checkbox back if the save is refused.
			await onEdit({ kind: "toggleInstance", id, notify, roster: all });
		},
		[roster, scope, onEdit],
	);

	const toggle = useCallback(
		async (id: string, notify: boolean) => {
			setMsg("");
			// A refused save returns the checkbox to what is stored — a switch that looks off while the notifications keep arriving
			// reads as the notification system being broken — and the store carries the instance scope and the rules along unchanged.
			await onEdit({ kind: "toggleType", id, notify });
		},
		[onEdit],
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
				either way. The one exception is deliberate and is below: you can silence the PUSH for a
				kind of request, and it still appears here.
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
							<span className="block text-2xs text-muted-soft mt-0.5">
								{t.description}
								{t.alerts && !on ? " Requests for your input still come through." : ""}
							</span>
						</span>
						<input
							type="checkbox"
							checked={on}
							onChange={(e) => void toggle(t.id, e.target.checked)}
							disabled={!ready}
							aria-label={`Notify me about ${t.label}`}
							className="mt-0.5"
						/>
					</label>
				);
			})}

			{/* Which AGENTS may interrupt (#784). Rendered from the live roster, defaulting to all; a
			    scope is stored only when at least one is switched off. Requests for your input still
			    come through from every agent — the same rule as the type mutes above. */}
			{roster && roster.length > 1 && (
				<div className="mt-4 pt-3 border-t border-line" data-testid="notification-instance-scope">
					<h4 className="text-sm font-semibold mb-1">Which agents</h4>
					<p className="text-2xs text-muted-soft mb-2">
						Switch off an agent to stop its updates reaching your phone. An agent waiting on you still gets
						through.
					</p>
					{roster.map((r) => {
						const on = scope.length === 0 || scope.includes(r.id);
						return (
							<label key={r.id} className="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
								<span className="text-sm min-w-0 truncate">{r.name || r.slug || r.id}</span>
								<input
									type="checkbox"
									checked={on}
									onChange={(e) => void toggleInstance(r.id, e.target.checked)}
									disabled={!ready}
									aria-label={`Notify me about ${r.name || r.slug || r.id}`}
									className="shrink-0"
								/>
							</label>
						);
					})}
				</div>
			)}

			{/* The OTHER axis (#991): the kinds of attention an agent can ask for. The section above is
			    "which part of the product", this is "what is being asked of me" — an approval, a value,
			    a blocker to clear. A toggle here silences only the push; the request is always written
			    to this list, which is why it can be switched off at all. */}
			{attentionEvents.filter((e) => e.pushOptional).length > 0 && (
				<div className="mt-4 pt-3 border-t border-line" data-testid="attention-push-controls">
					<h4 className="text-sm font-semibold mb-1">When an agent needs you</h4>
					<p className="text-2xs text-muted-soft mb-2">
						These are requests, not news — a run has stopped and is waiting. Switching one off stops the
						push to your devices only; it still arrives in your notifications, and the run stays stopped
						until you answer it.
					</p>
					{attentionEvents
						.filter((e) => e.pushOptional)
						.map((e) => {
							const on = !quiet.includes(e.id);
							return (
								<label key={e.id} className="flex items-start justify-between gap-3 py-2 cursor-pointer">
									<span className="text-sm min-w-0">
										<span className="font-semibold">{e.label}</span>
										<span className="block text-2xs text-muted-soft mt-0.5">{e.description}</span>
									</span>
									<input
										type="checkbox"
										checked={on}
										onChange={(ev) => void toggleAttention(e.id, ev.target.checked)}
										aria-label={`Push me when: ${e.label}`}
										className="mt-0.5 shrink-0"
									/>
								</label>
							);
						})}
				</div>
			)}

			{(msg || storeError) && (
				<p className="text-xs text-danger mt-2" role="alert">
					{msg || storeError}
				</p>
			)}
		</Card>
	);
}
