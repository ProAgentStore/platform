import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import Button from "../components/Button";
import Card from "../components/Card";
import LoadFailed from "../components/LoadFailed";
import { QUEUE_STATUS_LABEL, actionBody, actionLabel, confirmText } from "../lib/applications";
import { TONE_CLASS } from "../lib/localBrowser";
import type { ApplicationActionResponse, ApplicationRunnerSettingsView, ApplicationQueueAction, ApplicationQueueItem, ApplicationQueueStatus, ApplicationQueueView, ApplicationTraceView, ConnectionDeliveryList } from "../lib/types";

/**
 * The Applications tab (#958): the whole job-application queue across the owner's Scout → Tailor →
 * Runner pipeline, with typed actions. Every button posts ONE action to
 * `/application-queue/actions` — the same service the `applications` MCP tools call — carrying the
 * status and version it was read with, so a decision on something that changed meanwhile is refused.
 * The buttons shown are the ones the server says the item allows; the final-submit control appears
 * only when the Runner's policy allows an automatic submit for that application.
 */
export default function ApplicationsTab({ instanceId }: { instanceId: string }) {
	const [view, setView] = useState<ApplicationQueueView | null>(null);
	const [error, setError] = useState("");
	const [filter, setFilter] = useState<ApplicationQueueStatus | "">("");
	const [open, setOpen] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setView(await api<ApplicationQueueView>(`/v1/instances/${instanceId}/application-queue`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		load();
	}, [load]);
	usePolling(load, 5000, !!view?.items.some((i) => i.status === "tailoring" || i.status === "filling" || i.fillRun));

	if (error && !view) return <LoadFailed what="applications" detail={error} onRetry={load} />;
	if (!view) return <p className="text-sm text-muted">Loading applications…</p>;
	const items = filter ? view.items.filter((i) => i.status === filter) : view.items;
	const selected = view.items.find((i) => i.key === open) ?? null;

	return (
		<div className="max-w-4xl">
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Applications</h3>
				<fieldset className="flex flex-wrap gap-1.5 border-0 p-0 m-0 min-w-0" aria-label="Filter by status">
					<Button size="sm" variant={filter === "" ? "primary" : "secondary"} onClick={() => setFilter("")}>
						All {view.items.length}
					</Button>
					{(Object.keys(QUEUE_STATUS_LABEL) as ApplicationQueueStatus[]).map((s) => (
						<Button key={s} size="sm" variant={filter === s ? "primary" : "secondary"} onClick={() => setFilter(s)} disabled={!view.counts[s]}>
							{QUEUE_STATUS_LABEL[s].label} {view.counts[s]}
						</Button>
					))}
				</fieldset>
				<Limits view={view} instanceId={instanceId} onChanged={load} />
				{view.notes.map((n) => (
					<p key={n} className="text-xs text-muted mt-1">
						{n}
					</p>
				))}
			</Card>

			<Card className="mb-3 sm:mb-4">
				{items.length === 0 && <p className="text-sm text-muted">Nothing here.</p>}
				<ul className="flex flex-col divide-y divide-line">
					{items.map((i) => {
						const s = QUEUE_STATUS_LABEL[i.status];
						return (
							<li key={i.key}>
								<button type="button" onClick={() => setOpen(open === i.key ? null : i.key)} className="w-full text-left py-2 flex gap-3 items-baseline hover:bg-panel-hover">
									<span className={`text-xs font-semibold shrink-0 w-36 ${TONE_CLASS[s.tone]}`}>{s.label}</span>
									<span className="text-sm truncate flex-1">
										{i.title}
										{i.company ? ` — ${i.company}` : ""}
									</span>
									<span className="text-xs text-muted-soft shrink-0">{i.location ?? ""}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</Card>

			{selected && <Detail key={selected.key} instanceId={instanceId} item={selected} onChanged={load} />}

			{view.pipeline.runners[0] && <SubmissionPolicy runnerId={view.pipeline.runners[0]} onChanged={load} />}
		</div>
	);
}

function Limits({ view, instanceId, onChanged }: { view: ApplicationQueueView; instanceId: string; onChanged: () => void }) {
	const [msg, setMsg] = useState("");
	const replay = async (connectionId: string) => {
		try {
			const dead = await api<ConnectionDeliveryList>(`/v1/instances/${instanceId}/connections/deliveries?status=dead&limit=200`);
			const mine = dead.deliveries.filter((d) => d.connectionId === connectionId);
			for (const d of mine) await api(`/v1/instances/${instanceId}/connections/deliveries/${encodeURIComponent(d.id)}/replay`, { method: "POST" });
			setMsg(`Replayed ${mine.length} delivery(ies).`);
			onChanged();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<div className="mt-3 flex flex-col gap-1 text-xs text-muted">
			{view.limits.map((l) => (
				<span key={l.runnerInstanceId}>
					Auto-submit: {l.autoSubmitEnabled ? `on — ${l.remaining} of ${l.dailyCap} left today` : "off (every application stops for your review)"}
				</span>
			))}
			{view.connections.map((c) => (
				<span key={c.id} className="flex gap-2 items-center flex-wrap">
					<span>
						{c.eventType} → {c.action}: {c.delivered} delivered, {c.pending} pending
						{c.dead ? <span className="text-danger">, {c.dead} dead</span> : ""}
						{c.enabled ? "" : " (paused)"}
					</span>
					{c.dead > 0 && (
						<Button size="sm" onClick={() => replay(c.id)}>
							Replay dead
						</Button>
					)}
				</span>
			))}
			{msg && <span>{msg}</span>}
		</div>
	);
}

function Detail({ instanceId, item, onChanged }: { instanceId: string; item: ApplicationQueueItem; onChanged: () => void }) {
	const [busy, setBusy] = useState<ApplicationQueueAction | null>(null);
	const [msg, setMsg] = useState("");
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [trace, setTrace] = useState<ApplicationTraceView | null>(null);
	const pause = item.fillRun?.pause ?? null;
	// #988: the API's one durable, privacy-safe execution projection is authoritative. Keep the
	// legacy field as a read compatibility fallback for cards written before the projection existed.
	const progress = item.execution?.progress ?? item.fillProgress;
	const questions = pause?.question ? [pause.question] : item.questions;

	const act = async (action: ApplicationQueueAction) => {
		const ask = confirmText(action, item.status);
		if (ask && !window.confirm(ask)) return;
		setBusy(action);
		setMsg("");
		try {
			const given = questions.map((q) => ({ question: q, answer: (answers[q] ?? "").trim() })).filter((a) => a.answer);
			const out = await api<ApplicationActionResponse>(`/v1/instances/${instanceId}/application-queue/actions`, { method: "POST", body: JSON.stringify(actionBody(item, action, { answers: action === "resume" ? given : undefined })) });
			setMsg(`${actionLabel(action, item.status)}: now ${QUEUE_STATUS_LABEL[out.item.status].label}.`);
			onChanged();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
			onChanged();
		}
		setBusy(null);
	};
	const loadTrace = async () => {
		if (!item.applicationId) return;
		try {
			setTrace(await api<ApplicationTraceView>(`/v1/instances/${instanceId}/application-queue/${encodeURIComponent(item.applicationId)}/trace`));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<Card>
			<h3 className="text-base font-bold">{item.title}</h3>
			<p className="text-sm text-muted mb-2">
				{[item.company, item.location, item.source, item.postedDate].filter(Boolean).join(" · ")}
				{item.url && (
					<>
						{" · "}
						<a href={item.url} target="_blank" rel="noreferrer" className="underline">
							job page
						</a>
					</>
				)}
			</p>
			{item.matchRationale && <p className="text-sm mb-2">Why it matched: {item.matchRationale}</p>}

			{/* #986: what the RUNNER did, not what the status word implies. The sentence is the
			    server's, so this card, the Board card and an MCP reader say the same thing; the counts
			    and the checkpoint phase are shown beside it so "filled" is always falsifiable. */}
			{progress && (
				<p className="text-sm mb-2" data-testid="run-progress">
					<span className="font-semibold">Progress:</span> {progress.label}
					<span className="text-xs text-muted-soft">
						{" "}
						({progress.filled} field{progress.filled === 1 ? "" : "s"}, {progress.uploaded} attachment{progress.uploaded === 1 ? "" : "s"}
						{progress.checkpointPhase ? ` · checkpoint ${progress.checkpointPhase.replace(/_/g, " ")}` : ""})
					</span>
				</p>
			)}
			{item.execution?.checkpoint && (
				<p className="text-xs text-muted mb-2" data-testid="directive-reconciliation">
					Supervisor: {item.execution.directiveReconciliation.replace(/_/g, " ")}
					{item.execution.checkpoint.directive ? ` · ${item.execution.checkpoint.directive.kind.replace(/_/g, " ")} (${item.execution.checkpoint.directive.delivery.replace(/_/g, " ")})` : ""}
				</p>
			)}

			{item.artifacts && (
				<ul className="text-xs mb-2" aria-label="Tailored materials">
					{[item.artifacts.resume, item.artifacts.coverLetter].filter(Boolean).map((a) => (
						<li key={a?.kind}>
							{a?.kind === "resume" ? "Résumé" : "Cover letter"}: <code>{a?.path}</code> <span className="text-muted-soft">sha256 {a?.sha256.slice(0, 12)}…</span>
						</li>
					))}
					{item.profileVersion && <li className="text-muted-soft">From profile version {item.profileVersion}</li>}
				</ul>
			)}

			{item.submitPolicy && (
				<p className="text-xs mb-2">
					Submit policy: {item.submitPolicy.allowed ? <span className="text-success">this application may be submitted automatically</span> : <span>fill and wait for your review ({item.submitPolicy.failing.join(", ").replace(/_/g, " ")})</span>}
				</p>
			)}
			{/* #975: "it did nothing on the page" is a distinct, actionable cause — the counts that
			    prove it, and the ids the runner observed. No CLI prose reaches here. */}
			{item.diagnostic && (
				<p className="text-xs mb-2" data-testid="run-diagnostic">
					<span className="text-warning font-bold">Diagnosis:</span> {item.diagnostic.cause.replace(/_/g, " ")} — {item.diagnostic.bridgeCalls} browser call
					{item.diagnostic.bridgeCalls === 1 ? "" : "s"}, {item.diagnostic.filled} field{item.diagnostic.filled === 1 ? "" : "s"} filled after {Math.round(item.diagnostic.activeMs / 1000)}s (exit {item.diagnostic.engineExit})
					{item.diagnostic.signals.length ? ` · ${item.diagnostic.signals.join(", ").replace(/_/g, " ")}` : ""}
				</p>
			)}
			{/* #974: waiting for the machine is not a failure, and the card says which it is — the
			    position in line and when the next attempt is due, not a terminal "runner rejected". */}
			{item.queue && (
				<p className="text-xs mb-2" data-testid="queue-position">
					<span className={item.queue.exhausted ? "text-warning font-bold" : "text-accent font-bold"}>⏳ Queued:</span> {item.queue.label}
				</p>
			)}
			{/* #973: the owner's own decision about this job — approved, spent on a run, or no longer
			    usable because the materials changed under it. `label` is the server's wording, so the
			    board and an MCP reader say the same thing about the same authorization. */}
			{item.submitAuthorization && (
				<p className="text-xs mb-2" data-testid="submit-authorization">
					<span className={item.submitAuthorization.usable ? "text-success font-bold" : "text-muted-soft"}>Approval:</span> {item.submitAuthorization.label}
					{item.submitAuthorization.consumedRunId ? <span className="text-muted-soft"> (run {item.submitAuthorization.consumedRunId.slice(0, 8)})</span> : null}
				</p>
			)}
			{item.submittedAt && (
				<p className="text-sm text-success mb-2">
					Submitted {new Date(item.submittedAt).toLocaleString()}
					{item.submittedUrl ? ` — confirmation: ${item.submittedUrl}` : ""}
				</p>
			)}
			{item.submitAttempted && !item.submittedAt && <p className="text-sm text-warning mb-2">A final submit was attempted but not confirmed. Check the employer's site before doing anything else.</p>}

			{(item.blockReason || pause) && (
				<div className="mb-2 text-sm">
					<p className="text-warning font-semibold">Waiting: {(pause?.reason ?? item.blockReason ?? "").replace(/_/g, " ")}</p>
					{pause?.url && <p className="text-xs text-muted">At {pause.url} — open the runner's browser window on your machine to handle it, then Resume.</p>}
					{questions.map((q) => (
						<div key={q} className="mt-1">
							<p className="text-xs">{q}</p>
							{item.actions.includes("resume") && (
								<input aria-label={q} value={answers[q] ?? ""} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} className="w-full bg-paper border border-line rounded px-2 py-1 text-sm" placeholder="Your answer (leave empty to skip it)" />
							)}
						</div>
					))}
				</div>
			)}

			<fieldset className="flex flex-wrap gap-1.5 border-0 p-0 m-0 min-w-0" aria-label={`Actions for ${item.title}`}>
				{item.actions.map((a) => (
					<Button key={a} size="sm" variant={a === "start_fill" ? "danger" : a === "request_review" || a === "apply" ? "primary" : "secondary"} disabled={!!busy} onClick={() => act(a)}>
						{busy === a ? "…" : actionLabel(a, item.status)}
					</Button>
				))}
				{item.applicationId && (
					<Button size="sm" onClick={loadTrace}>
						Trace
					</Button>
				)}
			</fieldset>
			{msg && <p className="text-xs mt-2">{msg}</p>}

			{trace && (
				<ol className="mt-3 text-xs flex flex-col gap-0.5" aria-label="Application trace">
					{trace.entries.map((e) => (
						<li key={`${e.at}|${e.source}|${e.type}|${e.runId ?? ""}|${JSON.stringify(e.detail)}`} className="flex gap-2">
							<span className="text-muted-soft shrink-0 w-40">{e.at ? new Date(e.at).toLocaleString() : ""}</span>
							<span className="shrink-0 w-16">{e.source}</span>
							<span>{e.type}</span>
						</li>
					))}
				</ol>
			)}
		</Card>
	);
}

const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The handoff + submission policy (#953) — the Runner's settings. Fill-and-review is the default and
 * the server refuses to enable auto-submit until a profile source, approved roles, an allowed site
 * and a daily cap exist; its sentence is shown as it comes back.
 */
function SubmissionPolicy({ runnerId, onChanged }: { runnerId: string; onChanged: () => void }) {
	const [s, setS] = useState<ApplicationRunnerSettingsView["settings"] | null>(null);
	const [draft, setDraft] = useState({ profile: "", answers: "", allowDomains: "", roles: "", locations: "", exclude: "", dailyCap: "0", enabled: false });
	const [msg, setMsg] = useState("");
	const load = useCallback(async () => {
		try {
			const v = await api<ApplicationRunnerSettingsView>(`/v1/instances/${runnerId}/application-runner/settings`);
			setS(v.settings);
			const a = v.settings.autoSubmit;
			setDraft({ profile: v.settings.sources.profile ?? "", answers: v.settings.sources.answers ?? "", allowDomains: v.settings.allowDomains.join(", "), roles: a.roles.join(", "), locations: a.locations.join(", "), exclude: a.exclude.join(", "), dailyCap: String(a.dailyCap), enabled: a.enabled });
			if (v.error) setMsg(v.error);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	}, [runnerId]);
	useEffect(() => {
		load();
	}, [load]);
	if (!s) return null;
	const save = async () => {
		setMsg("");
		try {
			await api(`/v1/instances/${runnerId}/application-runner/settings`, {
				method: "PUT",
				body: JSON.stringify({
					sources: { profile: draft.profile.trim() || null, answers: draft.answers.trim() || null },
					allowDomains: list(draft.allowDomains),
					autoSubmit: { enabled: draft.enabled, roles: list(draft.roles), locations: list(draft.locations), exclude: list(draft.exclude), dailyCap: Number(draft.dailyCap) || 0 },
				}),
			});
			setMsg("Saved.");
			await load();
			onChanged();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	const field = (key: keyof typeof draft, label: string, hint: string) => (
		<label className="flex flex-col gap-0.5 text-xs">
			<span className="font-semibold">{label}</span>
			<input value={String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className="bg-paper border border-line rounded px-2 py-1 text-sm" placeholder={hint} />
		</label>
	);
	return (
		<Card className="mt-3 sm:mt-4">
			<h3 className="text-base font-bold mb-1">Submission policy</h3>
			<p className="text-sm text-muted mb-2">
				By default every application is filled on your machine and stops for your review — nothing is submitted. Auto-submit applies only to applications that match every rule below, up to the daily cap.
			</p>
			<div className="grid sm:grid-cols-2 gap-2 mb-2">
				{field("profile", "Profile file (in your workspace)", "profile.md")}
				{field("answers", "Answers file (optional)", "answers.md")}
				{field("allowDomains", "Allowed sites", "boards.greenhouse.io, jobs.lever.co")}
				{field("roles", "Approved roles", "engineer, developer")}
				{field("locations", "Approved locations (optional)", "Sydney, Remote")}
				{field("exclude", "Exclude when the job mentions", "contract, unpaid")}
				{field("dailyCap", "Auto-submits per day", "0")}
			</div>
			<label className="flex gap-2 items-center text-sm mb-2">
				<input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
				Enable auto-submit for applications that match this policy
			</label>
			<Button size="sm" variant="primary" onClick={save}>
				Save policy
			</Button>
			{msg && <p className="text-xs mt-2">{msg}</p>}
		</Card>
	);
}
