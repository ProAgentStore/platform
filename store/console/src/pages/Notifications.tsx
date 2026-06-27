import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Notification } from "../lib/types";

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
		<div className="max-w-[960px] mx-auto p-4 sm:p-6">
			<div className="flex justify-between items-center mb-4">
				<div className="flex items-center gap-3">
					<button type="button" onClick={() => navigate(-1)} className="text-sm text-muted hover:text-ink">&larr;</button>
					<h1 className="font-display text-xl font-bold">Notifications</h1>
				</div>
				<button type="button" onClick={markAllRead} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">
					Mark all read
				</button>
			</div>

			{loading ? (
				<p className="text-center py-8 text-muted text-sm">Loading...</p>
			) : notifications.length === 0 ? (
				<p className="text-center py-8 text-muted-soft text-sm">No notifications</p>
			) : (
				<div className="flex flex-col gap-2">
					{notifications.map((n) => (
						<div
							key={n.id}
							className={`p-3 bg-panel border border-line rounded-lg cursor-pointer hover:border-accent transition-all ${n.read ? "opacity-60" : ""}`}
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
						</div>
					))}
				</div>
			)}
		</div>
	);
}
