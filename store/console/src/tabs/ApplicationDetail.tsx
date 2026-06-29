import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@proagentstore/sdk/client";
import { renderMd } from "@proagentstore/sdk/ui";
import { usePolling } from "@proagentstore/sdk/hooks";
import type { RuntimeEvent } from "../lib/types";
import { ArrowLeft, Send } from "lucide-react";

// The job-application agent's dedicated Application detail page: a split view of
// one application — its fields + activity on the left, a chat scoped to THIS
// application on the right (messages are auto-prefixed with the application
// context). Deep-linked at /instances/:id/apply/:recordId. Ported from the
// pre-React console (commit 65e8729), rebuilt on the SDK + surface registry.

interface AppRecordFull {
	id: string;
	data?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const FIELD_ORDER = ["company", "role", "job_title", "status", "url", "cover_note", "resume_used", "submitted_at"];

export default function ApplicationDetail({ instanceId, recordId, onBack }: { instanceId: string; recordId: string; onBack: () => void }) {
	const [record, setRecord] = useState<AppRecordFull | null>(null);
	const [events, setEvents] = useState<RuntimeEvent[]>([]);
	const [messages, setMessages] = useState<{ id: string; role: string; content: string }[]>([]);
	const [input, setInput] = useState("");
	const [thinking, setThinking] = useState(false);
	const chatRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			const rec = await api<AppRecordFull>(`/v1/instances/${instanceId}/collections/applications/records/${recordId}`);
			setRecord(rec);
		} catch { /* keep last */ }
		try {
			const ev = await api<{ events: RuntimeEvent[] }>(`/v1/instances/${instanceId}/task-events`);
			const all = ev.events || [];
			const scoped = all.filter((e) => {
				const data = (e.data ?? {}) as Record<string, unknown>;
				return str(data.recordId) === recordId || data.collection === "applications";
			});
			// Apply task events (agent.*/job.*/task.*) are not record-scoped — if nothing
			// is tied to this record, fall back to the apply agent's recent progress so the
			// page (esp. for a stuck/failed application) still shows what happened.
			const applyActivity = all.filter((e) => /^(agent\.|job\.|task\.)/.test(e.type));
			setEvents(scoped.length ? scoped : applyActivity.slice(0, 30));
		} catch { /* keep last */ }
	}, [instanceId, recordId]);

	useEffect(() => { load(); }, [load]);
	usePolling(load, 4000);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack(); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onBack]);

	const d = (record?.data ?? {}) as Record<string, unknown>;
	const company = str(d.company) || str(d.Company) || "Untitled";
	const role = str(d.role) || str(d.job_title);
	const status = str(d.status) || "queued";
	const url = str(d.url);

	// Ordered fields: known apply fields first, then any extras, then metadata.
	const shown = new Set<string>();
	const fields: [string, unknown][] = [];
	for (const k of FIELD_ORDER) if (d[k] !== undefined) { shown.add(k); fields.push([k, d[k]]); }
	for (const [k, v] of Object.entries(d)) if (!shown.has(k)) fields.push([k, v]);
	if (record?.createdAt) fields.push(["created", record.createdAt]);
	if (record?.updatedAt) fields.push(["updated", record.updatedAt]);

	const send = async () => {
		const msg = input.trim();
		if (!msg) return;
		setInput("");
		setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: msg }]);
		setThinking(true);
		const context = `[Context: We are discussing the application to ${company} for the ${role || "?"} role. Application ID: ${recordId}. Status: ${status}. URL: ${url || "none"}]\n\n${msg}`;
		try {
			const data = await api<{ message?: { content: string }; error?: string }>(
				`/v1/instances/${instanceId}/chat`,
				{ method: "POST", body: JSON.stringify({ message: context }) },
			);
			if (data.message) setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", content: data.message!.content }]);
			else if (data.error) setMessages((m) => [...m, { id: crypto.randomUUID(), role: "system", content: data.error! }]);
		} catch (e) {
			setMessages((m) => [...m, { id: crypto.randomUUID(), role: "system", content: e instanceof Error ? e.message : String(e) }]);
		}
		setThinking(false);
		requestAnimationFrame(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; });
	};

	return (
		<div className="flex flex-col h-full min-h-0">
			<button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted hover:text-accent mb-2 self-start">
				<ArrowLeft size={15} /> Back to applications
			</button>
			<div className="mb-3">
				<h2 className="text-lg font-bold break-words">{company}{role ? ` — ${role}` : ""}</h2>
				<div className="flex items-center gap-2 flex-wrap mt-1 text-xs">
					<span className="px-1.5 py-0.5 rounded font-medium bg-accent-soft text-accent">{status}</span>
					{url && <a href={url} target="_blank" rel="noopener" className="text-muted hover:text-accent truncate max-w-xs">{url}</a>}
				</div>
			</div>

			<div className="grid md:grid-cols-2 gap-4 flex-1 min-h-0">
				{/* Left: fields + activity */}
				<div className="overflow-auto min-h-0 flex flex-col gap-4">
					<div>
						<div className="text-[0.7rem] font-extrabold uppercase tracking-wide text-muted-soft mb-1.5">Application Details</div>
						<div className="grid grid-cols-2 gap-2">
							{fields.map(([k, v]) => {
								const val = typeof v === "object" ? JSON.stringify(v, null, 2) : str(v);
								const isLong = val.length > 100;
								return (
									<div key={k} className={`bg-paper border border-line rounded-lg p-2 ${isLong ? "col-span-2" : ""}`}>
										<div className="text-[0.65rem] uppercase tracking-wide text-muted-soft mb-0.5">{k.replace(/_/g, " ")}</div>
										{isLong
											? <pre className="text-[0.7rem] text-ink whitespace-pre-wrap break-words">{val}</pre>
											: <div className="text-xs text-ink break-words">{val || "—"}</div>}
									</div>
								);
							})}
						</div>
					</div>
					<div>
						<div className="text-[0.7rem] font-extrabold uppercase tracking-wide text-muted-soft mb-1.5">Activity</div>
						{events.length === 0 ? (
							<div className="text-xs text-muted-soft">No activity for this application yet.</div>
						) : (
							<div className="flex flex-col gap-1.5">
								{events.map((e) => (
									<div key={e.id} className="bg-paper border border-line rounded-lg p-2 text-[0.7rem]">
										<div className="flex justify-between gap-2"><span className="font-mono text-ink">{e.type}</span></div>
										{e.message && <div className="text-muted mt-0.5">{e.message}</div>}
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Right: contextual chat */}
				<div className="flex flex-col min-h-0 border border-line rounded-xl overflow-hidden">
					<div className="px-3 py-2 border-b border-line text-[0.72rem] font-bold uppercase tracking-wide text-muted">Chat about this application</div>
					<div ref={chatRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0">
						<div className="self-center text-xs text-muted bg-panel rounded-full px-3 py-1">Discussing: {company}{role ? ` — ${role}` : ""}</div>
						{messages.map((m) => (
							<div
								key={m.id}
								className={`max-w-[90%] px-3 py-2 rounded-xl text-sm ${m.role === "user" ? "bg-accent text-white self-end" : m.role === "system" ? "bg-yellow/10 text-yellow self-center text-xs" : "bg-panel border border-line self-start"}`}
							>
								{m.role === "assistant" ? (
									// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMd output is HTML-escaped (XSS-safe)
									<div className="msg-md" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
								) : (
									<span className="whitespace-pre-wrap">{m.content}</span>
								)}
							</div>
						))}
						{thinking && <div className="text-muted text-xs self-start">Thinking…</div>}
					</div>
					<div className="flex gap-1.5 p-2 border-t border-line">
						<input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") send(); }}
							placeholder="Ask about this application…"
							className="flex-1 bg-panel border border-line rounded-xl px-3 py-2 text-sm"
						/>
						<button type="button" onClick={send} aria-label="Send" className="px-3 bg-accent text-white rounded-xl"><Send size={14} /></button>
					</div>
				</div>
			</div>
		</div>
	);
}
