import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import {
	browserTimeZone,
	buildSchedule,
	countdownTo,
	DEFAULT_SCHEDULE_DRAFT,
	describeSchedule,
	formatRun,
	scheduleUsesWallClock,
	WEEKDAYS,
	type ScheduleDraft,
	type ScheduleMode,
} from "../lib/triggerSchedule";
// One zone list for the whole console (#345) — a trigger's schedule and the account preference
// must offer the same vocabulary, or a zone you can schedule in is one you cannot set as yours.
import { timeZoneOptions } from "../lib/accountTimezone";
import type { TriggerAction } from "../lib/types";
import Button from "../components/Button";
import Card from "../components/Card";
import {
	eventHeadline,
	eventTone,
	historyHeadline,
	sourceLabel,
	statusLabel,
	syncCounts,
	TONE_CLASS,
	truncatePayload,
	type TriggerEvent,
} from "../lib/triggerEvents";

/**
 * Triggers — inbound webhooks and schedules (#16, #18, #19).
 *
 * Lifted out of SettingsTab, which had grown to hold this card's state, its handlers and its
 * JSX inline. The three things this card gained are all about not lying to the user:
 *
 *  • #16 — config that would be silently dropped is now refused, by name, at the save button.
 *    The API is the authority (`validateTriggerConfig`); this only asks it early, via /preview,
 *    so the message arrives while you are still looking at the field you got wrong.
 *  • #18 — a schedule is built from presets against a real timezone, and the next runs are
 *    fetched from the SERVER. Nothing here computes a fire time: a preview computed in the
 *    browser is a second scheduler, and the day the two disagree the console shows a time at
 *    which nothing happens.
 *  • #19 — the run history that has always been recorded is finally readable, per trigger.
 *  • #358 — the action picker is rendered from the SERVER's per-instance answer, not from a
 *    hardcoded label list. The old list offered "Run browser task" on all 26 instances when one
 *    could perform it, and the store route accepted every one, so a schedule that could never do
 *    anything saved cleanly and looked healthy. The gate lives in the API (three doors: console,
 *    API, MCP); this makes the picker agree with it by reading the same answer.
 */

/**
 * Was a second hand-written copy of the same union. It happened to be the CORRECT one — the copy in
 * `IndexingTab` had four of the seven — but two copies is how they came to disagree, so both now
 * point at the one declaration in lib/types (#617).
 */
type TriggerActionType = TriggerAction;

/** One row of `GET /v1/triggers/actions` — the vocabulary, judged against THIS instance. */
interface TriggerActionOffer {
	action: TriggerActionType;
	label: string;
	available: boolean;
	/** Why not, in the words the save path would use. Null when available. */
	reason: string | null;
	requires: string | null;
}
type ConnectorProviderType = "google_drive" | "zoho_workdrive";

export interface ConnectorGrant {
	id: string;
	provider: ConnectorProviderType;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
}

interface InstanceTrigger {
	id: string;
	name: string;
	type: "webhook" | "cron";
	action: TriggerActionType;
	enabled: boolean;
	schedule?: string | null;
	config?: Record<string, unknown>;
	/** Why this saved trigger can never run here (#358), or null/absent when it can. */
	unavailable?: string | null;
	webhookUrl?: string;
	lastRunAt?: string | null;
	nextRunAt?: string | null;
	failureCount?: number;
	lastError?: string | null;
}

interface PreviewResp {
	schedule: string | null;
	timezone: string | null;
	jitterMinutes: number | null;
	runs: string[];
	issues: string[];
	error: string | null;
}

/** Which fields of each action a payload path may be mapped onto — mirrors MAPPING_TARGETS in
 *  workers/api/src/lib/trigger-config.ts. The API validates; this only decides what to render. */
const MAPPABLE: Partial<Record<TriggerActionType, Array<{ id: string; label: string; hint: string }>>> = {
	create_task: [
		{ id: "title", label: "Task title", hint: "lead.name" },
		{ id: "description", label: "Task description", hint: "lead.note" },
	],
	add_knowledge: [
		{ id: "title", label: "Document title", hint: "doc.name" },
		{ id: "content", label: "Document text", hint: "doc.body" },
		{ id: "sourceUrl", label: "Source URL", hint: "doc.link" },
	],
	log_event: [{ id: "message", label: "Logged message", hint: "event.summary" }],
};

const inputClass = "text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full";

export default function TriggersSection({
	instanceId,
	driveGrants,
	workdriveGrants,
}: {
	instanceId: string;
	driveGrants: ConnectorGrant[];
	workdriveGrants: ConnectorGrant[];
}) {
	const [triggers, setTriggers] = useState<InstanceTrigger[]>([]);
	const [msg, setMsg] = useState("");
	const [name, setName] = useState("");
	const [type, setType] = useState<"webhook" | "cron">("webhook");
	const [action, setAction] = useState<TriggerActionType>("create_task");
	const [schedule, setSchedule] = useState<ScheduleDraft>({ ...DEFAULT_SCHEDULE_DRAFT });
	const [timezone, setTimezone] = useState(browserTimeZone());
	const [jitter, setJitter] = useState("");
	const [provider, setProvider] = useState<ConnectorProviderType>("google_drive");
	const [grantId, setGrantId] = useState("");
	const [pipeline, setPipeline] = useState("");
	const [collection, setCollection] = useState("");
	const [browseUrl, setBrowseUrl] = useState("");
	const [mapping, setMapping] = useState<Record<string, string>>({});
	const [showMapping, setShowMapping] = useState(false);
	const [preview, setPreview] = useState<PreviewResp | null>(null);
	const [openHistory, setOpenHistory] = useState<string | null>(null);
	const [events, setEvents] = useState<Record<string, TriggerEvent[]>>({});
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [openPayload, setOpenPayload] = useState<string | null>(null);
	const [offers, setOffers] = useState<TriggerActionOffer[]>([]);

	const grants = provider === "google_drive" ? driveGrants : workdriveGrants;
	const mappableFields = MAPPABLE[action];
	const selectedOffer = offers.find((o) => o.action === action);

	const loadTriggers = useCallback(async () => {
		try {
			const d = await api<{ triggers?: InstanceTrigger[] }>(`/v1/triggers?instanceId=${encodeURIComponent(instanceId)}`);
			setTriggers(d.triggers || []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed to load triggers");
		}
	}, [instanceId]);

	// The picker's whole vocabulary, judged against THIS instance (#358). Nothing is rendered
	// from a list held here: an option this console invented would be one the API has never
	// heard of, and an option it judged for itself would be one the API might refuse.
	const loadActions = useCallback(async () => {
		try {
			const d = await api<{ actions?: TriggerActionOffer[] }>(`/v1/triggers/actions?instanceId=${encodeURIComponent(instanceId)}`);
			setOffers(d.actions || []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed to load trigger actions");
		}
	}, [instanceId]);

	useEffect(() => { loadTriggers(); }, [loadTriggers]);
	useEffect(() => { loadActions(); }, [loadActions]);

	/** The config object exactly as it will be POSTed — one definition, used by both the live
	 *  preview and the save, so the thing validated is the thing stored. */
	const draftConfig = useMemo(() => {
		const config: Record<string, unknown> = {};
		if (action === "sync_connector") {
			config.provider = provider;
			const chosen = grantId || grants[0]?.id || "";
			if (chosen) config.grantId = chosen;
		}
		if (action === "run_pipeline" && pipeline.trim()) config.pipeline = pipeline.trim();
		if (action === "insert_record" && collection.trim()) config.collection = collection.trim();
		if (action === "run_browse" && browseUrl.trim()) config.url = browseUrl.trim();
		if (mappableFields) {
			const entries = Object.entries(mapping).filter(([field, path]) => path.trim() && mappableFields.some((f) => f.id === field));
			if (entries.length) config.mapping = Object.fromEntries(entries.map(([f, p]) => [f, p.trim()]));
		}
		if (type === "cron") {
			const j = Math.max(0, Math.min(Math.trunc(Number(jitter) || 0), 720));
			if (j) config.jitterMinutes = j;
			// Only send a zone when it can change anything. Attaching one to `every 15 minutes`
			// would be stored, ignored, and then reported as ignored — noise for no gain.
			const built = buildSchedule(schedule);
			if ("schedule" in built && scheduleUsesWallClock(built.schedule) && timezone) config.timezone = timezone;
		}
		return config;
	}, [action, provider, grantId, grants, pipeline, collection, browseUrl, mapping, mappableFields, type, jitter, schedule, timezone]);

	const built = useMemo(() => buildSchedule(schedule), [schedule]);
	const localError = type === "cron" && "error" in built ? built.error : "";

	// Live preview: what the server would do with this exact draft. Debounced because it runs
	// on every keystroke of the schedule fields.
	const previewSeq = useRef(0);
	useEffect(() => {
		if (localError) { setPreview(null); return; }
		const scheduleStr = "schedule" in built ? built.schedule : undefined;
		const seq = ++previewSeq.current;
		const t = setTimeout(async () => {
			try {
				const d = await api<PreviewResp>("/v1/triggers/preview", {
					method: "POST",
					// instanceId so the preview also reports an action this agent cannot perform —
					// same class of problem as config that would be stored and then ignored (#358).
					body: JSON.stringify({ instanceId, type, action, schedule: scheduleStr, config: draftConfig, count: 3 }),
				});
				if (previewSeq.current === seq) setPreview(d);
			} catch {
				if (previewSeq.current === seq) setPreview(null);
			}
		}, 350);
		return () => clearTimeout(t);
	}, [built, localError, type, action, draftConfig, instanceId]);

	const defaultName = () =>
		action === "sync_connector" ? `${provider === "google_drive" ? "Google Drive" : "WorkDrive"} sync`
			: action === "run_pipeline" ? `Run ${pipeline.trim() || "pipeline"}`
				: action === "insert_record" ? `Insert into ${collection.trim() || "collection"}`
					: action === "run_browse" ? "Scheduled browser run"
						: type === "webhook" ? "Inbound webhook" : "Scheduled run";

	const createTrigger = async () => {
		if (type === "cron" && localError) { setMsg(localError); return; }
		if (action === "sync_connector" && !draftConfig.grantId) {
			setMsg(`Grant a ${provider === "google_drive" ? "Google Drive" : "Zoho WorkDrive"} folder before creating a sync trigger.`);
			return;
		}
		try {
			await api("/v1/triggers", {
				method: "POST",
				body: JSON.stringify({
					instanceId,
					name: name.trim() || defaultName(),
					type,
					action,
					schedule: type === "cron" && "schedule" in built ? built.schedule : undefined,
					config: Object.keys(draftConfig).length ? draftConfig : undefined,
				}),
			});
			setName("");
			setPipeline("");
			setCollection("");
			setMapping({});
			setMsg("Trigger created.");
			await loadTriggers();
		} catch (e) {
			// The API's message names the offending field (#16) — show it verbatim rather than
			// flattening it to "Failed", which is what made a dropped field invisible before.
			setMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const loadEvents = useCallback(async (triggerId: string) => {
		setLoadingHistory(true);
		try {
			const d = await api<{ events?: TriggerEvent[] }>(`/v1/triggers/${triggerId}/events?limit=20`);
			setEvents((prev) => ({ ...prev, [triggerId]: d.events || [] }));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed to load run history");
		}
		setLoadingHistory(false);
	}, []);

	const toggleHistory = async (triggerId: string) => {
		if (openHistory === triggerId) { setOpenHistory(null); return; }
		setOpenHistory(triggerId);
		if (!events[triggerId]) await loadEvents(triggerId);
	};

	const runTrigger = async (trigger: InstanceTrigger) => {
		setMsg(`Running "${trigger.name}"…`);
		try {
			await api(`/v1/triggers/${trigger.id}/run`, { method: "POST", body: JSON.stringify({ manual: true }) });
			setMsg("Run finished — see the history below.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Run failed — see the history below.");
		}
		// Either way the run left rows behind, and those rows are the answer. Open the history
		// rather than leaving the user with a toast and nowhere to look (#19).
		setOpenHistory(trigger.id);
		await loadEvents(trigger.id);
		await loadTriggers();
	};

	const deleteTrigger = async (trigger: InstanceTrigger) => {
		if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
		try {
			await api(`/v1/triggers/${trigger.id}`, { method: "DELETE" });
			setMsg("Trigger deleted.");
			await loadTriggers();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const copyWebhook = async (url: string) => {
		// IGNORABLE (#291): clipboard, not the server — see TmuxTab. The URL stays visible.
		await navigator.clipboard?.writeText(url).catch(() => undefined);
		setMsg("Webhook URL copied.");
	};

	return (
		<Card className="mb-3 sm:mb-4 min-w-0">
			<h3 className="text-base font-bold mb-1">Triggers</h3>
			<p className="text-sm text-muted mb-3">
				Start work from an inbound webhook or a schedule. Triggers run inside this private instance.
			</p>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs font-semibold">Name</span>
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName()} className={inputClass} />
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-semibold">Type</span>
					<select value={type} onChange={(e) => setType(e.target.value as "webhook" | "cron")} className={inputClass}>
						<option value="webhook">Webhook</option>
						<option value="cron">Schedule</option>
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs font-semibold">Action</span>
					<select value={action} onChange={(e) => setAction(e.target.value as TriggerActionType)} className={inputClass} disabled={!offers.length}>
						{offers.length === 0 ? (
							<option value={action}>Loading actions…</option>
						) : (
							// An action this agent cannot perform is DISABLED, not hidden: a picker
							// that quietly has fewer entries on some agents teaches nothing, and
							// "why can't I schedule a browser run here?" is answered by the reason
							// below rather than by an option that is simply absent.
							offers.map((o) => (
								<option key={o.action} value={o.action} disabled={!o.available}>
									{o.label}{o.available ? "" : " — not supported by this agent"}
								</option>
							))
						)}
					</select>
				</label>
			</div>

			{/* The reason, verbatim from the server, if a saved trigger's action is selected on an
			    agent that cannot run it (reachable by editing an older row). */}
			{selectedOffer && !selectedOffer.available && (
				<p className="text-xs text-danger mb-3">{selectedOffer.reason}</p>
			)}

			{/* Schedule editor (#18) — presets, so the common cases never require cron. */}
			{type === "cron" && (
				<div className="border border-line rounded-lg p-3 mb-3 min-w-0">
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
						<label className="flex flex-col gap-1">
							<span className="text-xs font-semibold">Runs</span>
							<select value={schedule.mode} onChange={(e) => setSchedule({ ...schedule, mode: e.target.value as ScheduleMode })} className={inputClass}>
								<option value="hourly">Every hour</option>
								<option value="daily">Daily at…</option>
								<option value="weekly">Weekly on…</option>
								<option value="interval">Every N minutes/hours</option>
								<option value="cron">Cron expression</option>
							</select>
						</label>
						{schedule.mode === "weekly" && (
							<label className="flex flex-col gap-1">
								<span className="text-xs font-semibold">Day</span>
								<select value={schedule.weekday} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })} className={inputClass}>
									{WEEKDAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
								</select>
							</label>
						)}
						{(schedule.mode === "daily" || schedule.mode === "weekly") && (
							<label className="flex flex-col gap-1">
								<span className="text-xs font-semibold">Time</span>
								<input type="time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} className={inputClass} />
							</label>
						)}
						{schedule.mode === "interval" && (
							<>
								<label className="flex flex-col gap-1">
									<span className="text-xs font-semibold">Every</span>
									<input value={schedule.every} onChange={(e) => setSchedule({ ...schedule, every: e.target.value })} inputMode="numeric" className={inputClass} />
								</label>
								<label className="flex flex-col gap-1">
									<span className="text-xs font-semibold">Unit</span>
									<select value={schedule.unit} onChange={(e) => setSchedule({ ...schedule, unit: e.target.value as "minutes" | "hours" })} className={inputClass}>
										<option value="minutes">minutes</option>
										<option value="hours">hours</option>
									</select>
								</label>
							</>
						)}
						{schedule.mode === "cron" && (
							<label className="flex flex-col gap-1 sm:col-span-2">
								<span className="text-xs font-semibold">Cron</span>
								<input value={schedule.cron} onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })} placeholder="0 8 * * *" className={`${inputClass} font-mono`} />
							</label>
						)}
						{scheduleUsesWallClock("schedule" in built ? built.schedule : "") && (
							<label className="flex flex-col gap-1">
								<span className="text-xs font-semibold">Timezone</span>
								<select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputClass}>
									{timeZoneOptions(browserTimeZone()).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
								</select>
							</label>
						)}
						<label className="flex flex-col gap-1">
							<span className="text-xs font-semibold">Jitter ± min</span>
							<input
								value={jitter}
								onChange={(e) => setJitter(e.target.value)}
								placeholder="0 (on the dot)"
								inputMode="numeric"
								title="Randomise the fire time by ± this many minutes so it doesn't run exactly on schedule."
								className={inputClass}
							/>
						</label>
					</div>

					{/* Next runs — from the server, computed by the same code the sweep runs (#18). */}
					<div className="mt-3 text-xs">
						{localError ? (
							<div className="text-danger">{localError}</div>
						) : preview?.error ? (
							<div className="text-danger">{preview.error}</div>
						) : preview?.runs.length ? (
							<div>
								<div className="text-muted font-semibold mb-1">
									Next runs {preview.jitterMinutes ? `(± ${preview.jitterMinutes} min jitter)` : ""}
								</div>
								<ul className="flex flex-col gap-0.5">
									{preview.runs.map((iso) => {
										const f = formatRun(iso, preview.timezone);
										return (
											<li key={iso} className="text-muted min-w-0">
												<span className="font-semibold text-ink">{f.local}</span>
												<span className="text-muted-soft"> {f.zone}</span>
												<span className="text-muted-soft"> · {f.utc} UTC</span>
												<span className="text-muted-soft"> · {countdownTo(iso)}</span>
											</li>
										);
									})}
								</ul>
							</div>
						) : null}
					</div>
				</div>
			)}

			{action === "sync_connector" && (
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Connector</span>
						<select value={provider} onChange={(e) => { setProvider(e.target.value as ConnectorProviderType); setGrantId(""); }} className={inputClass}>
							<option value="google_drive">Google Drive</option>
							<option value="zoho_workdrive">Zoho WorkDrive</option>
						</select>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Folder grant</span>
						<select value={grantId || grants[0]?.id || ""} onChange={(e) => setGrantId(e.target.value)} className={inputClass}>
							{grants.length === 0 ? (
								<option value="">No granted folders</option>
							) : grants.map((grant) => <option key={grant.id} value={grant.id}>{grant.resourceName}</option>)}
						</select>
					</label>
				</div>
			)}

			{action === "run_pipeline" && (
				<label className="flex flex-col gap-1 mb-3">
					<span className="text-xs font-semibold">Pipeline name</span>
					<input value={pipeline} onChange={(e) => setPipeline(e.target.value)} placeholder="a pipeline configured on this agent" className={inputClass} />
					<span className="text-2xs text-muted">The trigger runs this declarative pipeline (from the agent's <code>config.pipelines</code>) on fire.</span>
				</label>
			)}

			{action === "insert_record" && (
				<label className="flex flex-col gap-1 mb-3">
					<span className="text-xs font-semibold">Target collection</span>
					<input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="collection name" className={inputClass} />
					<span className="text-2xs text-muted">Webhook/cron payload is inserted as a record into this collection (an explicit <code>record</code> field wins).</span>
				</label>
			)}

			{action === "run_browse" && (
				<label className="flex flex-col gap-1 mb-3">
					<span className="text-xs font-semibold">Start URL</span>
					<input value={browseUrl} onChange={(e) => setBrowseUrl(e.target.value)} placeholder="https://www.facebook.com/friends/requests" className={inputClass} />
					<span className="text-2xs text-muted">On schedule, drives the browser (via <code>pags up</code>) toward this agent's objective from this URL. Runner must be online at run time, or the run is skipped.</span>
				</label>
			)}

			{/* Payload mapping (#16). Collapsed by default: the conventions cover flat payloads,
			    and this only matters when the source nests its data. */}
			{mappableFields && (
				<div className="border border-line rounded-lg p-3 mb-3">
					<button type="button" onClick={() => setShowMapping((v) => !v)} className="text-xs font-semibold text-muted hover:text-accent">
						{showMapping ? "▾" : "▸"} Payload mapping (optional)
					</button>
					{showMapping && (
						<div className="mt-2">
							<p className="text-2xs text-muted mb-2">
								By default the payload's <code>title</code>, <code>description</code>, <code>content</code> or <code>text</code> are used.
								Map a path instead when your source nests its data — e.g. <code>lead.name</code> or <code>items.0.title</code>.
								A path this payload does not have simply falls back to the default.
							</p>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
								{mappableFields.map((field) => (
									<label key={field.id} className="flex flex-col gap-1">
										<span className="text-xs font-semibold">{field.label}</span>
										<input
											value={mapping[field.id] || ""}
											onChange={(e) => setMapping({ ...mapping, [field.id]: e.target.value })}
											placeholder={field.hint}
											className={`${inputClass} font-mono`}
										/>
									</label>
								))}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Anything that would be stored and then ignored, said before the save (#16). */}
			{preview?.issues.length ? (
				<ul className="text-xs text-warning bg-warning-soft border border-warning-line rounded-lg px-3 py-2 mb-3 flex flex-col gap-1">
					{preview.issues.map((issue) => <li key={issue}>{issue}</li>)}
				</ul>
			) : null}

			<Button variant="primary" onClick={createTrigger} className="mb-4">Add trigger</Button>

			<div className="flex flex-col gap-2">
				{triggers.length === 0 ? (
					<p className="text-xs text-muted">No triggers configured yet.</p>
				) : triggers.map((trigger) => {
					const history = events[trigger.id];
					const health = history ? historyHeadline(history) : null;
					const tz = typeof trigger.config?.timezone === "string" ? trigger.config.timezone : null;
					return (
						<div key={trigger.id} className="bg-paper border border-line rounded-lg p-3 min-w-0">
							<div className="flex items-start justify-between gap-3 flex-wrap">
								<div className="min-w-0">
									<div className="text-sm font-bold">{trigger.name}</div>
									<div className="text-xs text-muted mt-0.5">
										{trigger.type === "cron" ? describeSchedule(trigger.schedule, tz) : "Webhook"}
										{" · "}{trigger.action.replace(/_/g, " ")}
										{trigger.action === "sync_connector" && trigger.config?.provider ? ` · ${trigger.config.provider === "google_drive" ? "Google Drive" : "WorkDrive"}` : ""}
									</div>
									{trigger.nextRunAt && (
										<div className="text-xs text-muted-soft mt-0.5">
											Next {formatRun(trigger.nextRunAt, tz).local} {tz || "UTC"} · {countdownTo(trigger.nextRunAt)}
										</div>
									)}
									{/* A row saved before the create-time gate, wired to an action this
									    agent cannot perform (#358). It is not deleted or disabled for
									    the user — that is theirs — but it stops looking healthy, which
									    is what let it fail silently on a schedule for months. */}
									{trigger.unavailable && (
										<div className="text-xs text-danger mt-1">
											<span className="font-semibold">This trigger can never run. </span>{trigger.unavailable}
										</div>
									)}
									{health && <div className={`text-xs mt-1 ${health.tone === "bad" ? "text-danger" : health.tone === "warn" ? "text-warning" : "text-muted"}`}>{health.text}</div>}
									{!health && trigger.lastError && <div className="text-xs text-danger mt-1">{trigger.lastError}</div>}
								</div>
								<div className="flex gap-2 shrink-0 flex-wrap justify-end">
									<Button size="sm" onClick={() => toggleHistory(trigger.id)}>
										{openHistory === trigger.id ? "Hide history" : "History"}
									</Button>
									<Button size="sm" onClick={() => runTrigger(trigger)}>Run now</Button>
									<Button size="sm" variant="danger" onClick={() => deleteTrigger(trigger)}>Delete</Button>
								</div>
							</div>

							{trigger.webhookUrl && (
								<div className="flex gap-2 mt-2">
									{/* Read-only, but still a focusable field a screen reader lands on — and the
									    only thing identifying it is the Copy button beside it. */}
									<input readOnly aria-label={`Webhook URL for ${trigger.name}`} value={trigger.webhookUrl} className="flex-1 min-w-0 text-xs bg-panel border border-line rounded px-2 py-1.5 font-mono" />
									<Button size="sm" onClick={() => copyWebhook(trigger.webhookUrl || "")}>Copy</Button>
								</div>
							)}

							{/* Run history (#19) — received / running / succeeded / failed, with the
							    connector-sync numbers and a bounded payload. */}
							{openHistory === trigger.id && (
								<div className="mt-3 border-t border-line pt-3">
									{loadingHistory && !history ? (
										<p className="text-xs text-muted">Loading run history…</p>
									) : !history?.length ? (
										<p className="text-xs text-muted">
											No runs recorded yet. {trigger.type === "webhook" ? "POST to the webhook URL above, or use Run now." : "It will appear here after the first scheduled run."}
										</p>
									) : (
										<div className="flex flex-col gap-1.5">
											{history.map((event) => {
												const counts = syncCounts(event.payload);
												const open = openPayload === event.id;
												return (
													<div key={event.id} className="min-w-0">
														<div className="flex items-start gap-2 flex-wrap">
															<span className={`text-2xs px-2 py-0.5 rounded-full border font-semibold shrink-0 ${TONE_CLASS[eventTone(event)]}`}>
																{statusLabel(event.status)}
															</span>
															<span className="text-2xs text-muted-soft shrink-0">{sourceLabel(event.type)}</span>
															<span className="text-2xs text-muted-soft shrink-0">{new Date(event.created_at.includes("T") ? event.created_at : `${event.created_at.replace(" ", "T")}Z`).toLocaleString()}</span>
															<span className="text-xs text-muted min-w-0 break-words">{eventHeadline(event)}</span>
															{event.payload && (
																<button type="button" onClick={() => setOpenPayload(open ? null : event.id)} className="text-2xs text-muted hover:text-accent font-semibold shrink-0">
																	{open ? "hide payload" : "payload"}
																</button>
															)}
														</div>
														{counts?.errors.length ? (
															<ul className="text-2xs text-danger mt-0.5 ml-2 flex flex-col gap-0.5">
																{counts.errors.slice(0, 5).map((err) => <li key={err} className="break-words">{err}</li>)}
															</ul>
														) : null}
														{open && (
															<pre className="mt-1 text-2xs bg-panel border border-line rounded p-2 overflow-x-auto max-h-56 overflow-y-auto">
																{truncatePayload(event.payload)}
															</pre>
														)}
													</div>
												);
											})}
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
			{msg && <div className="text-xs text-muted mt-2 break-words">{msg}</div>}
		</Card>
	);
}
