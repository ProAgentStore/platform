import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import type { Notification } from "../lib/types";
import { pushSupported, pushPermission, enablePush, sendTestPush } from "../lib/push";

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
		<div className="max-w-[960px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
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
								// Navigate to the relevant instance if possible
								if (n.instanceId) navigate(`/instances/${n.instanceId}`);
								else load();
							}}
						>
							<div className="flex justify-between items-start">
								<div>
									<div className="font-semibold text-sm">{n.title}</div>
									{n.body && <div className="text-sm text-muted mt-0.5">{n.body}</div>}
									<div className="text-xs text-muted-soft mt-1">{new Date(n.createdAt).toLocaleString()}</div>
								</div>
								{!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1" />}
							</div>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Browser-alerts status + enable/test — so push is findable outside the top banner. */
function AlertsCard() {
	const [perm, setPerm] = useState<string>(() => pushPermission());
	const [busy, setBusy] = useState(false);
	const [tested, setTested] = useState(false);
	if (!pushSupported()) return null;

	const onEnable = async () => { setBusy(true); await enablePush(); setPerm(pushPermission()); setBusy(false); };
	const onTest = async () => { setBusy(true); await sendTestPush(); setBusy(false); setTested(true); setTimeout(() => setTested(false), 4000); };

	return (
		<div className="mb-4 p-4 bg-panel border border-line rounded-xl flex flex-wrap items-center gap-3">
			<div className="flex-1 min-w-[10rem]">
				<div className="text-sm font-bold text-ink">🔔 Browser alerts</div>
				<div className="text-sm text-muted mt-0.5">
					{perm === "granted" ? "On — you'll get a notification (even with this tab closed) when an agent needs you."
						: perm === "denied" ? "Blocked. Turn on notifications for proagentstore.online in your browser's site settings, then reload."
						: "Off — turn them on so an agent can reach you the moment it needs an answer."}
				</div>
			</div>
			{perm === "granted" ? (
				<button type="button" onClick={onTest} disabled={busy} className="px-4 py-2 rounded-lg border border-line text-sm font-semibold text-ink hover:border-accent disabled:opacity-50 shrink-0">
					{tested ? "Sent ✓ (switch tabs to see it)" : busy ? "Sending…" : "Send a test alert"}
				</button>
			) : perm !== "denied" ? (
				<button type="button" onClick={onEnable} disabled={busy} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-bold disabled:opacity-50 shrink-0">
					{busy ? "Enabling…" : "Enable alerts"}
				</button>
			) : null}
		</div>
	);
}
