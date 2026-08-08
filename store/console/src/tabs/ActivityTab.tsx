import { useState, useCallback, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import { formatTime } from "@proagentstore/sdk/ui";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { activityBusy } from "../lib/pollBusy";

// The agent's activity log as a readable, live timeline — everything it DID (tool
// calls, record writes, cron/webhook fires, summaries, errors), newest first. This is
// the *process/reasoning* view, deliberately distinct from Data (the end results) and
// Board (runtime task jobs). Fed by GET /v1/instances/:id/activity (append-only log).

interface ActivityEvent {
	id: string;
	type: string;
	channel?: string;
	data?: Record<string, unknown>;
	createdAt: string;
}

const s = (v: unknown) => (v == null ? "" : String(v));

/** icon + human label per event type. */
const META: Record<string, { icon: string; label: (d: Record<string, unknown>) => string }> = {
	"chat.message": { icon: "💬", label: () => "You messaged the agent" },
	"chat.response": { icon: "🤖", label: () => "Agent replied" },
	"tool.called": { icon: "🔧", label: (d) => `Called tool: ${s(d.tool)}${d.success === false ? " — failed" : ""}` },
	"tool.result": { icon: "✓", label: (d) => `Tool result${d.tool ? `: ${s(d.tool)}` : ""}` },
	"knowledge.added": { icon: "📚", label: () => "Knowledge added" },
	"knowledge.removed": { icon: "📚", label: () => "Knowledge removed" },
	"knowledge.updated": { icon: "📚", label: () => "Knowledge updated" },
	"repo.indexed": { icon: "🔍", label: (d) => `Repo indexed${d.repo ? `: ${s(d.repo)}` : ""}` },
	"file.uploaded": { icon: "📎", label: (d) => `File uploaded${d.name || d.key ? `: ${s(d.name || d.key)}` : ""}` },
	"file.deleted": { icon: "🗑", label: () => "File deleted" },
	"collection.created": { icon: "🗃️", label: (d) => `Collection created: ${s(d.collection)}` },
	"collection.record.created": { icon: "➕", label: (d) => `Record added → ${s(d.collection)}` },
	"collection.record.updated": { icon: "✏️", label: (d) => `Record updated → ${s(d.collection)}` },
	"collection.record.deleted": { icon: "🗑", label: (d) => `Record removed → ${s(d.collection)}` },
	"memory.written": { icon: "🧠", label: () => "Memory saved" },
	"memory.deleted": { icon: "🧠", label: () => "Memory deleted" },
	"task.created": { icon: "📋", label: () => "Task created" },
	"task.updated": { icon: "📋", label: () => "Task updated" },
	"cron.triggered": { icon: "⏰", label: () => "Scheduled run fired" },
	"webhook.received": { icon: "🪝", label: () => "Webhook received" },
	"summary.generated": { icon: "📝", label: () => "Conversation summarized" },
	"email.confirmation_link_found": { icon: "✉️", label: () => "Confirmation link found" },
	error: { icon: "⚠️", label: (d) => `Error: ${s(d.message).slice(0, 140)}` },
};

export default function ActivityTab({ instanceId }: { instanceId: string }) {
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const data = await api<{ events?: ActivityEvent[] }>(`/v1/instances/${instanceId}/activity?limit=100`);
			setEvents(data.events || []);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load activity");
		}
	}, [instanceId]);

	useEffect(() => {
		load();
	}, [load]);
	// A live timeline while the agent is doing things, and a static page when it is not (#272).
	// The log itself is the only liveness signal this surface has, so "busy" is the age of its
	// newest event: a working agent emits several events per turn, and one that stopped an hour
	// ago emits none. 100 events re-fetched every 4s forever is the shape being paid for here.
	useTieredPolling(load, { activeMs: 4000, passiveMs: 20000 }, activityBusy(events));

	return (
		<div>
			<div className="flex items-center justify-between gap-3 mb-3">
				<div>
					<h3 className="text-base font-bold mb-0.5">Activity</h3>
					<div className="text-xs text-muted">
						{events.length} event{events.length !== 1 ? "s" : ""} · everything the agent did, newest first
					</div>
				</div>
				<button
					type="button"
					onClick={load}
					className="text-xs px-2.5 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold"
				>
					Refresh
				</button>
			</div>

			{error && (
				<div className="mb-3 text-xs px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-danger">
					Couldn't refresh activity: {error}
				</div>
			)}

			{events.length === 0 ? (
				<div className="text-center text-muted-soft text-sm py-10 border border-line rounded-xl">
					No activity yet — nothing this agent has done shows up here until it runs a tool, writes a record, or fires on a schedule.
				</div>
			) : (
				<div className="border border-line rounded-xl overflow-hidden divide-y divide-line">
					{events.map((e) => {
						const meta = META[e.type] ?? { icon: "•", label: () => e.type };
						const hasDetail = !!e.data && Object.keys(e.data).length > 0;
						const open = expanded === e.id;
						return (
							<div key={e.id} className="bg-paper">
								<button
									type="button"
									onClick={() => hasDetail && setExpanded(open ? null : e.id)}
									className={`w-full flex items-center gap-2.5 px-3 py-2 text-left ${hasDetail ? "hover:bg-panel-hover cursor-pointer" : "cursor-default"}`}
								>
									<span className="text-base shrink-0 w-5 text-center">{meta.icon}</span>
									<span className="flex-1 min-w-0 text-sm break-words">{meta.label(e.data ?? {})}</span>
									{e.channel && (
										<span className="shrink-0 text-2xs text-muted-soft border border-line rounded px-1 py-0.5 hidden sm:inline">
											{e.channel}
										</span>
									)}
									<span className="shrink-0 text-2xs text-muted-soft">{formatTime(e.createdAt)}</span>
									{hasDetail && <span className="shrink-0 text-2xs text-muted-soft w-3">{open ? "▲" : "▼"}</span>}
								</button>
								{open && hasDetail && (
									<pre className="text-2xs text-muted bg-panel/60 border-t border-line px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words">
										{JSON.stringify(e.data, null, 2)}
									</pre>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
