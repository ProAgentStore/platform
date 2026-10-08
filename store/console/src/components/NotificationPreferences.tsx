import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
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
	onSaved,
	instances,
	onInstancesSaved,
	attentionEvents,
	pushOff,
	onPushOffSaved,
}: {
	types: ReadonlyArray<NotificationTypeSpec>;
	muted: string[];
	onSaved: (muted: string[]) => void;
	/**
	 * The instance scope (#784): ids whose updates may interrupt you; empty means every instance.
	 * Per ACCOUNT like the mute above, and for the same reason — a push fans out to every device.
	 */
	instances: string[];
	onInstancesSaved: (instances: string[]) => void;
	/**
	 * The owner-attention vocabulary (#991) — the KINDS of attention an agent can ask for, which is
	 * a different axis from the product-area mutes above. Served by the route, mapped here, so a new
	 * event gets its control from `lib/owner-attention.ts`.
	 */
	attentionEvents: ReadonlyArray<AttentionEventSpec>;
	pushOff: string[];
	onPushOffSaved: (pushOff: string[]) => void;
}) {
	const [local, setLocal] = useState<string[]>(muted);
	const [scope, setScope] = useState<string[]>(instances);
	const [quiet, setQuiet] = useState<string[]>(pushOff);
	const [roster, setRoster] = useState<Pick<Instance, "id" | "name" | "slug">[] | null>(null);
	const [msg, setMsg] = useState("");

	// The parent owns the stored value; re-sync when it finishes loading or another save lands.
	useEffect(() => setLocal(muted), [muted]);
	useEffect(() => setScope(instances), [instances]);
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
			const current = scope.length ? scope.filter((s) => all.includes(s)) : all;
			const next = notify ? [...new Set([...current, id])] : current.filter((s) => s !== id);
			if (next.length === 0) {
				setMsg("At least one agent has to stay on — use the switches above to silence a kind of update everywhere.");
				return;
			}
			const stored = next.length >= all.length ? [] : next;
			const previous = scope;
			setScope(stored);
			setMsg("");
			try {
				// The section is a whole-object write, so the mutes ride along unchanged.
				await api("/v1/preferences", {
					method: "PUT",
					body: JSON.stringify({ notifications: { muted: local, ...(stored.length ? { instances: stored } : {}) } }),
				});
				onInstancesSaved(stored);
			} catch {
				setScope(previous);
				setMsg("Couldn't save that. Try again.");
			}
		},
		[roster, scope, local, onInstancesSaved],
	);

	const toggle = useCallback(
		async (id: string, notify: boolean) => {
			const next = notify ? local.filter((m) => m !== id) : [...new Set([...local, id])];
			const previous = local;
			setLocal(next);
			setMsg("");
			try {
				// The section is a whole-object write (#784): the instance scope rides along unchanged.
				await api("/v1/preferences", {
					method: "PUT",
					body: JSON.stringify({ notifications: { muted: next, ...(scope.length ? { instances: scope } : {}) } }),
				});
				onSaved(next);
			} catch {
				// Put the control back rather than showing a save that did not happen — the same rule
				// the timezone control follows, and it matters more here: a checkbox that looks off
				// while the notifications keep arriving reads as the notification system being broken.
				setLocal(previous);
				setMsg("Couldn't save that. Try again.");
			}
		},
		[local, scope, onSaved],
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

			{msg && <p className="text-xs text-danger mt-2">{msg}</p>}
		</Card>
	);
}
