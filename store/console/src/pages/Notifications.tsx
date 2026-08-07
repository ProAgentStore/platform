import { useState, useEffect, useCallback } from "react";
import Page from "../components/Page";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Notification } from "../lib/types";
import { pushSupported, pushPermission, enablePush, sendTestPush } from "../lib/push";
import { notificationRoute } from "../lib/deepLink";

/**
 * When it arrived — reading the field the API actually sends.
 *
 * `/v1/notifications` returns rows straight from D1, so it is `created_at`; this page read
 * `createdAt`, which is always undefined, so every row in the list has been rendering
 * "Invalid Date". Both are accepted, and an unparseable value renders nothing rather than the
 * words "Invalid Date", which look like a bug in the notification rather than a missing field.
 */
function formatWhen(n: Notification): string {
	const raw = n.created_at || n.createdAt;
	if (!raw) return "";
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export default function Notifications() {
	const navigate = useNavigate();
	const [notifications, setNotifications] = useState<Notification[]>([]);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		try {
			const d = await api<{ notifications: Notification[] }>("/v1/notifications");
			setNotifications(d.notifications || []);
		} catch {}
		setLoading(false);
	}, []);

	useEffect(() => { load(); }, [load]);

	const markAllRead = async () => {
		await api("/v1/notifications/read-all", { method: "POST" });
		load();
	};

	const markRead = async (id: string) => {
		await api(`/v1/notifications/${id}/read`, { method: "POST" }).catch(() => {});
	};

	return (
		<Page>
			<div className="flex justify-between items-center mb-4">
				<div className="flex items-center gap-3">
					<button type="button" onClick={() => navigate(-1)} className="text-sm text-muted hover:text-ink">&larr;</button>
					<h1 className="font-display text-xl font-bold">Notifications</h1>
				</div>
				<button type="button" onClick={markAllRead} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">
					Mark all read
				</button>
			</div>

			<AlertsCard />

			{loading ? (
				<p className="text-center py-8 text-muted text-sm">Loading...</p>
			) : notifications.length === 0 ? (
				<p className="text-center py-8 text-muted-soft text-sm">No notifications</p>
			) : (
				<div className="flex flex-col gap-2">
					{notifications.map((n) => (
						<button
							type="button"
							key={n.id}
							className={`p-3 text-left bg-panel border border-line rounded-lg cursor-pointer hover:border-accent transition-all ${n.read ? "opacity-60" : ""}`}
							onClick={async () => {
								if (!n.read) await markRead(n.id);
								// The row's own deep link first — it is the specific place the notification is
								// about (#338). A deploy has no `instanceId` on the row, so before this the
								// only clickable outcome for one was a silent reload.
								const route = notificationRoute(n.url);
								if (route) navigate(route);
								else if (n.instanceId) navigate(`/instances/${n.instanceId}`);
								// A pre-#338 row points at GitHub Actions: open it where it lives.
								else if (n.url?.startsWith("https://")) window.open(n.url, "_blank", "noopener");
								else load();
							}}
						>
							<div className="flex justify-between items-start">
								<div>
									<div className="font-semibold text-sm">
										{/* A run that has STOPPED and is waiting for you reads differently from news
										    about one that finished — the same distinction a `needs_human` board card
										    draws, and the one a per-type mute is never allowed to hide (#360). */}
										{n.kind === "alert" && (
											<span className="mr-1.5 align-middle text-[0.6rem] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/15 text-accent">
												Needs you
											</span>
										)}
										{n.title}
									</div>
									{n.body && <div className="text-sm text-muted mt-0.5">{n.body}</div>}
									<div className="text-xs text-muted-soft mt-1">{formatWhen(n)}</div>
								</div>
								{!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1" />}
							</div>
						</button>
					))}
				</div>
			)}
		</Page>
	);
}

/** Browser-alerts status + enable/test — so push is findable outside the top banner. */
function AlertsCard() {
	const [perm, setPerm] = useState<string>(() => pushPermission());
	const [busy, setBusy] = useState(false);
	const [tested, setTested] = useState(false);
	const [failed, setFailed] = useState("");
	if (!pushSupported()) return null;

	// Both results were discarded, and this card is keyed on `pushPermission()` — the BROWSER's
	// permission, not whether a subscription reached the server. `enablePush()` returns "error"
	// for exactly the case where permission was granted and the subscribe/save failed, which is
	// the case that reads as "granted": the card flipped to "you'll get a notification … an agent
	// waiting on you always gets through", replaced the Enable button so there was nothing left to
	// retry, and `sendPushToUser` had no subscription to fan out to. Layout.tsx already reads this
	// return value; this call site was the deviation.
	const onEnable = async () => {
		setBusy(true);
		setFailed("");
		const res = await enablePush();
		if (res === "error") setFailed("Couldn't finish turning alerts on — nothing will reach you yet. Try again.");
		setPerm(pushPermission());
		setBusy(false);
	};
	const onTest = async () => {
		setBusy(true);
		setFailed("");
		const sent = await sendTestPush();
		setBusy(false);
		if (!sent) return setFailed("Couldn't send the test — this is the platform's end, not your browser's.");
		setTested(true);
		setTimeout(() => setTested(false), 4000);
	};

	return (
		<div className="mb-4 p-4 bg-panel border border-line rounded-xl flex flex-wrap items-center gap-3">
			<div className="flex-1 min-w-[10rem]">
				<div className="text-sm font-bold text-ink">🔔 Browser alerts</div>
				{/* The failure REPLACES the status line rather than sitting under it: "On — you'll get
				    a notification" beside "couldn't finish turning alerts on" is the same claim the
				    swallow was making, only slower. */}
				<div className={`text-sm mt-0.5 ${failed ? "text-red" : "text-muted"}`}>
					{failed ? failed
						: perm === "granted" ? "On — you'll get a notification (even with this tab closed) when an agent needs you."
						: perm === "denied" ? "Blocked. Turn on notifications for proagentstore.online in your browser's site settings, then reload."
						: "Off — turn them on so an agent can reach you the moment it needs an answer."}
				</div>
				{/* Before #360 the only remedy for a noisy class of notification was turning push OFF
				    entirely, which also loses the handoff — the one alert the product needs to
				    interrupt for. Point at the control from the page where the noise is noticed. */}
				{perm === "granted" && !failed && (
					<div className="text-xs text-muted-soft mt-1">
						Too noisy?{" "}
						<Link to="/preferences" className="text-accent font-semibold hover:underline">
							Choose which ones reach you
						</Link>{" "}
						— an agent waiting on you always gets through.
					</div>
				)}
			</div>
			{/* A granted permission with a failed enrolment must keep the ENABLE button: it is the
			    only control that re-runs the subscribe, and replacing it with "send a test alert"
			    left the user pressing the one button that cannot fix what is wrong. */}
			{perm === "granted" && !failed ? (
				<button type="button" onClick={onTest} disabled={busy} className="px-4 py-2 rounded-lg border border-line text-sm font-semibold text-ink hover:border-accent disabled:opacity-50 shrink-0">
					{tested ? "Sent ✓ (switch tabs to see it)" : busy ? "Sending…" : "Send a test alert"}
				</button>
			) : perm !== "denied" ? (
				<button type="button" onClick={onEnable} disabled={busy} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-bold disabled:opacity-50 shrink-0">
					{busy ? "Enabling…" : failed ? "Try again" : "Enable alerts"}
				</button>
			) : null}
		</div>
	);
}
