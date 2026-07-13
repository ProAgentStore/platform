import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { formatDateTime } from "@proagentstore/sdk/ui";
import type { KnowledgeDoc } from "../lib/types";

type SourceType = "knowledge" | "message" | "file" | "collection" | "repo";
type ConnectorProvider = "google_drive" | "zoho_workdrive";

interface VectorSource {
	sourceType: SourceType;
	sourceId: string;
	name: string;
	chunks: number;
	chars: number;
	lastIndexed: string;
	preview: string;
}

interface VectorStats {
	totalSources: number;
	totalChunks: number;
	totalChars: number;
	sources: VectorSource[];
}

interface FileItem {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	extractionStatus?: "none" | "extracted" | "unsupported" | "failed";
	extractedTextLength?: number;
	extractionError?: string;
	createdAt?: string;
	updatedAt?: string;
}

interface InstanceTrigger {
	id: string;
	name: string;
	type: "webhook" | "cron";
	action: "create_task" | "add_knowledge" | "log_event" | "sync_connector";
	enabled: boolean;
	schedule?: string | null;
	config?: { provider?: ConnectorProvider; grantId?: string };
	lastRunAt?: string | null;
	nextRunAt?: string | null;
	failureCount?: number;
	lastError?: string | null;
}

interface TriggerEvent {
	id: string;
	trigger_id?: string;
	type: "webhook" | "cron" | "manual";
	status: "received" | "running" | "succeeded" | "failed";
	message?: string | null;
	payload?: unknown;
	error?: string | null;
	created_at?: string;
}

interface SyncPayload {
	provider?: ConnectorProvider;
	grantId?: string;
	scanned?: number;
	imported?: number;
	skipped?: number;
	errors?: string[];
}

const TYPE_LABEL: Record<SourceType, string> = {
	knowledge: "Document",
	file: "File",
	repo: "Repo",
	message: "Conversation",
	collection: "Collection",
};

const PROVIDER_LABEL: Record<ConnectorProvider, string> = {
	google_drive: "Google Drive",
	zoho_workdrive: "Zoho WorkDrive",
};

const fmtCount = (n: number) => new Intl.NumberFormat().format(n || 0);
const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n || 0}`);
const fmtBytes = (n?: number) => {
	if (!n || n <= 0) return "";
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	return `${Math.max(1, Math.round(n / 1024))}KB`;
};

const payloadObject = (payload: unknown): SyncPayload => {
	if (!payload) return {};
	if (typeof payload === "string") {
		try {
			const parsed = JSON.parse(payload);
			return parsed && typeof parsed === "object" ? parsed as SyncPayload : {};
		} catch {
			return {};
		}
	}
	return typeof payload === "object" ? payload as SyncPayload : {};
};

const eventTime = (event?: TriggerEvent) => event?.created_at ? formatDateTime(event.created_at) : "";

function statusClasses(status: "indexed" | "pending" | "failed" | "running") {
	if (status === "indexed") return "border-green/30 bg-green/10 text-green";
	if (status === "failed") return "border-red/30 bg-red/10 text-red";
	if (status === "running") return "border-blue/30 bg-blue/10 text-blue";
	return "border-yellow/30 bg-yellow/10 text-yellow";
}

function StatusPill({ status, label }: { status: "indexed" | "pending" | "failed" | "running"; label: string }) {
	return (
		<span className={`text-[0.7rem] px-2 py-0.5 rounded-full border font-semibold ${statusClasses(status)}`}>
			{label}
		</span>
	);
}

function StatBox({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
	return (
		<div className="bg-panel border border-line rounded-lg p-3 min-w-0">
			<div className="text-xl font-bold leading-tight">{value}</div>
			<div className="text-xs text-muted font-semibold mt-0.5">{label}</div>
			{hint && <div className="text-[0.7rem] text-muted-soft mt-1 truncate">{hint}</div>}
		</div>
	);
}

export default function IndexingTab({ instanceId }: { instanceId: string }) {
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [files, setFiles] = useState<FileItem[]>([]);
	const [vectors, setVectors] = useState<VectorStats | null>(null);
	const [triggers, setTriggers] = useState<InstanceTrigger[]>([]);
	const [triggerEvents, setTriggerEvents] = useState<Record<string, TriggerEvent[]>>({});
	const [loading, setLoading] = useState(false);
	const [msg, setMsg] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setMsg("");
		try {
			const [knowledgeRes, filesRes, vectorsRes, triggersRes] = await Promise.allSettled([
				api<{ documents?: KnowledgeDoc[]; knowledge?: KnowledgeDoc[] }>(`/v1/instances/${instanceId}/knowledge`),
				api<{ files?: FileItem[] }>(`/v1/instances/${instanceId}/files`),
				api<VectorStats>(`/v1/instances/${instanceId}/vectors`),
				api<{ triggers?: InstanceTrigger[] }>(`/v1/triggers?instanceId=${encodeURIComponent(instanceId)}`),
			]);

			if (knowledgeRes.status === "fulfilled") setDocs(knowledgeRes.value.documents || knowledgeRes.value.knowledge || []);
			if (filesRes.status === "fulfilled") setFiles(filesRes.value.files || []);
			if (vectorsRes.status === "fulfilled") setVectors(vectorsRes.value);

			const loadedTriggers = triggersRes.status === "fulfilled" ? triggersRes.value.triggers || [] : [];
			const syncTriggers = loadedTriggers.filter((t) => t.action === "sync_connector");
			setTriggers(syncTriggers);

			const events = await Promise.allSettled(
				syncTriggers.map(async (trigger) => {
					const d = await api<{ events?: TriggerEvent[] }>(`/v1/triggers/${trigger.id}/events?limit=10`);
					return [trigger.id, d.events || []] as const;
				}),
			);
			const nextEvents: Record<string, TriggerEvent[]> = {};
			for (const res of events) {
				if (res.status === "fulfilled") nextEvents[res.value[0]] = res.value[1];
			}
			setTriggerEvents(nextEvents);

			const failedLoads = [knowledgeRes, filesRes, vectorsRes, triggersRes].filter((r) => r.status === "rejected").length;
			if (failedLoads) setMsg("Some indexing status could not be loaded. Refresh or check connection.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed to load indexing status");
		}
		setLoading(false);
	}, [instanceId]);

	useEffect(() => { load(); }, [load]);

	const summary = useMemo(() => {
		const vectorKeys = new Set((vectors?.sources || []).map((s) => `${s.sourceType}:${s.sourceId}`));
		const docItems = docs.map((doc) => {
			const indexed = vectorKeys.has(`knowledge:${doc.id}`);
			const record = doc as KnowledgeDoc & { addedAt?: string; sourceUrl?: string };
			return {
				id: doc.id,
				kind: "Document",
				name: doc.title || doc.id,
				status: indexed ? "indexed" as const : "pending" as const,
				reason: indexed ? "In vector index" : (doc.content || "").trim() ? "Waiting for vectors" : "No content yet",
				source: doc.source || record.sourceUrl || "",
				createdAt: doc.createdAt || record.addedAt,
			};
		});
		const fileItems = files.map((file) => {
			const indexed = vectorKeys.has(`file:${file.id}`);
			const failed = file.extractionStatus === "failed" || file.extractionStatus === "unsupported";
			return {
				id: file.id,
				kind: "File",
				name: file.name || file.id,
				status: indexed ? "indexed" as const : failed ? "failed" as const : "pending" as const,
				reason: indexed
					? "In vector index"
					: file.extractionStatus === "failed"
						? file.extractionError || "Text extraction failed"
						: file.extractionStatus === "unsupported"
							? "This file type is not searchable yet"
							: "Waiting for text extraction or vectors",
				source: [file.mimeType, fmtBytes(file.size)].filter(Boolean).join(" · "),
				createdAt: file.createdAt || file.updatedAt,
			};
		});
		const pending = [...docItems, ...fileItems].filter((item) => item.status !== "indexed");
		const failedSyncEvents = Object.values(triggerEvents).flat().filter((event) => event.status === "failed");
		return {
			docItems,
			fileItems,
			pending,
			indexedCount: (vectors?.sources || []).length,
			pendingCount: pending.filter((item) => item.status === "pending").length,
			failedCount: pending.filter((item) => item.status === "failed").length + failedSyncEvents.length,
		};
	}, [docs, files, vectors, triggerEvents]);

	const latestSyncTotal = useMemo(() => {
		let scanned = 0;
		let imported = 0;
		let skipped = 0;
		for (const trigger of triggers) {
			const latest = triggerEvents[trigger.id]?.find((event) => event.status === "succeeded");
			const payload = payloadObject(latest?.payload);
			scanned += payload.scanned || 0;
			imported += payload.imported || 0;
			skipped += payload.skipped || 0;
		}
		return { scanned, imported, skipped };
	}, [triggers, triggerEvents]);

	return (
		<div className="max-w-[1200px]">
			<div className="flex flex-wrap justify-between items-start gap-3 mb-4">
				<div>
					<h2 className="text-xl font-bold">Indexing</h2>
					<p className="text-sm text-muted mt-1">
						Track what is searchable by this agent, what is still pending, and recent Drive or WorkDrive sync results.
					</p>
				</div>
				<button
					type="button"
					onClick={load}
					disabled={loading}
					className="text-xs px-3 py-2 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-50"
				>
					{loading ? "Refreshing..." : "Refresh"}
				</button>
			</div>

			{msg && <div className="mb-4 text-xs text-yellow bg-yellow/10 border border-yellow/25 rounded-lg px-3 py-2">{msg}</div>}

			<div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
				<StatBox label="Indexed sources" value={fmtCount(summary.indexedCount)} hint={`${fmtCount(vectors?.totalChunks || 0)} chunks`} />
				<StatBox label="Pending" value={fmtCount(summary.pendingCount)} hint="Not searchable yet" />
				<StatBox label="Failed" value={fmtCount(summary.failedCount)} hint="Needs attention" />
				<StatBox label="Indexed chars" value={fmtChars(vectors?.totalChars || 0)} hint="Embedded text" />
				<StatBox label="Last sync imported" value={fmtCount(latestSyncTotal.imported)} hint={`${fmtCount(latestSyncTotal.scanned)} scanned`} />
			</div>

			<div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)] gap-4 items-start">
				<div className="min-w-0 flex flex-col gap-4">
					<section>
						<div className="flex justify-between items-center gap-3 mb-2">
							<h3 className="text-base font-bold">Pending and failed</h3>
							<span className="text-xs text-muted">{summary.pending.length} item{summary.pending.length === 1 ? "" : "s"}</span>
						</div>
						{loading && !vectors ? (
							<p className="text-center py-5 text-muted-soft text-sm">Loading indexing status...</p>
						) : summary.pending.length === 0 ? (
							<div className="bg-panel border border-line rounded-lg p-4 text-sm text-muted">No pending knowledge or file indexing work found.</div>
						) : (
							<div className="flex flex-col gap-2">
								{summary.pending.map((item) => (
									<div key={`${item.kind}:${item.id}`} className="bg-panel border border-line rounded-lg p-3 flex justify-between items-start gap-3">
										<div className="min-w-0">
											<div className="flex items-center gap-2 min-w-0">
												<span className="text-sm font-semibold truncate">{item.name}</span>
												<span className="text-xs text-muted shrink-0">{item.kind}</span>
											</div>
											<div className="text-xs text-muted mt-1">{item.reason}</div>
											{item.source && <div className="text-[0.7rem] text-muted-soft mt-1 truncate">{item.source}</div>}
										</div>
										<StatusPill status={item.status} label={item.status === "failed" ? "Needs attention" : "Pending"} />
									</div>
								))}
							</div>
						)}
					</section>

					<section>
						<div className="flex justify-between items-center gap-3 mb-2">
							<h3 className="text-base font-bold">Indexed sources</h3>
							<span className="text-xs text-muted">{vectors?.totalSources || 0} source{(vectors?.totalSources || 0) === 1 ? "" : "s"}</span>
						</div>
						{!vectors || vectors.sources.length === 0 ? (
							<div className="bg-panel border border-line rounded-lg p-4 text-sm text-muted">Nothing is indexed yet.</div>
						) : (
							<div className="flex flex-col gap-2">
								{vectors.sources.map((source) => (
									<div key={`${source.sourceType}:${source.sourceId}`} className="bg-panel border border-line rounded-lg p-3">
										<div className="flex justify-between items-start gap-3">
											<div className="min-w-0">
												<div className="text-sm font-semibold truncate">{source.name}</div>
												<div className="text-xs text-muted mt-1">
													{TYPE_LABEL[source.sourceType] || source.sourceType} · {fmtCount(source.chunks)} chunk{source.chunks === 1 ? "" : "s"} · {fmtChars(source.chars)} chars
												</div>
											</div>
											<StatusPill status="indexed" label="Indexed" />
										</div>
										{source.lastIndexed && <div className="text-[0.7rem] text-muted-soft mt-2">Indexed {formatDateTime(source.lastIndexed)}</div>}
										{source.preview && <p className="text-xs text-muted mt-2 line-clamp-2">{source.preview}</p>}
									</div>
								))}
							</div>
						)}
					</section>
				</div>

				<aside className="min-w-0 xl:sticky xl:top-16">
					<div className="bg-panel border border-line rounded-lg p-3">
						<div className="flex justify-between items-center gap-3 mb-3">
							<h3 className="text-base font-bold">Connector sync</h3>
							<span className="text-xs text-muted">{triggers.length} trigger{triggers.length === 1 ? "" : "s"}</span>
						</div>
						{triggers.length === 0 ? (
							<p className="text-sm text-muted">No Google Drive or Zoho WorkDrive sync triggers are configured for this instance.</p>
						) : (
							<div className="flex flex-col gap-3">
								{triggers.map((trigger) => {
									const events = triggerEvents[trigger.id] || [];
									const latest = events[0];
									const latestSucceeded = events.find((event) => event.status === "succeeded");
									const payload = payloadObject(latestSucceeded?.payload);
									const provider = trigger.config?.provider || payload.provider;
									const running = latest?.status === "running" || latest?.status === "received";
									const failed = latest?.status === "failed" || !!trigger.lastError;
									return (
										<div key={trigger.id} className="border border-line rounded-lg p-3">
											<div className="flex justify-between items-start gap-3">
												<div className="min-w-0">
													<div className="text-sm font-semibold truncate">{trigger.name}</div>
													<div className="text-xs text-muted mt-1">
														{provider ? PROVIDER_LABEL[provider] || provider : "Connector"} · {trigger.schedule || trigger.type}
													</div>
												</div>
												<StatusPill
													status={failed ? "failed" : running ? "running" : latestSucceeded ? "indexed" : "pending"}
													label={failed ? "Failed" : running ? "Running" : latestSucceeded ? "Synced" : "No runs"}
												/>
											</div>
											<div className="grid grid-cols-3 gap-2 my-3 text-center">
												<div className="border border-line rounded-md py-2">
													<div className="text-sm font-bold">{fmtCount(payload.scanned || 0)}</div>
													<div className="text-[0.65rem] text-muted">Scanned</div>
												</div>
												<div className="border border-line rounded-md py-2">
													<div className="text-sm font-bold">{fmtCount(payload.imported || 0)}</div>
													<div className="text-[0.65rem] text-muted">Imported</div>
												</div>
												<div className="border border-line rounded-md py-2">
													<div className="text-sm font-bold">{fmtCount(payload.skipped || 0)}</div>
													<div className="text-[0.65rem] text-muted">Skipped</div>
												</div>
											</div>
											{latest?.error || trigger.lastError ? (
												<div className="text-xs text-red mb-2">{latest?.error || trigger.lastError}</div>
											) : latest?.message ? (
												<div className="text-xs text-muted mb-2">{latest.message}</div>
											) : null}
											{payload.errors?.length ? (
												<div className="text-xs text-red mb-2">{payload.errors.slice(0, 2).join("; ")}</div>
											) : null}
											<div className="text-[0.7rem] text-muted-soft">
												{latest ? `Latest event ${eventTime(latest)}` : "Waiting for first run"}
												{trigger.nextRunAt ? ` · Next ${formatDateTime(trigger.nextRunAt)}` : ""}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</aside>
			</div>
		</div>
	);
}
