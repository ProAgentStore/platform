import MarkdownText from "../components/MarkdownText";
import RunReplay, { useBrowserArtifacts } from "../components/RunReplay";
import { replayFrames, SCREENSHOTS_OFF_TEXT } from "../lib/runReplay";
import { AutoSubmitConfirmDialog, AutoSubmitDangerBanner, ManualReviewBadge } from "../components/AutoSubmitPolicy";
import { type AutoSubmitAllowance, type AutoSubmitRules, disablePayload, enablePayload, rulesPayload } from "../lib/autoSubmitPolicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import Button from "../components/Button";
import Card from "../components/Card";
import LoadFailed from "../components/LoadFailed";
import UploadedTailorSourcesSection from "../components/UploadedTailorSourcesSection";
import ApplicationHandoffLive from "../components/ApplicationHandoffLive";
import { ASSERT_STATEMENT_PROMPT, QUEUE_STATUS_LABEL, actionBody, actionLabel, canCheckSubmission, checkNeedsOwner, confirmText, reconciliationSentence } from "../lib/applications";
import { notificationRoute } from "../lib/deepLink";
import { TONE_CLASS } from "../lib/localBrowser";
import type { ApplicationActionResponse, ApplicationReconciliationHandoffResponse, ApplicationReconciliationResponse, ApplicationRunnerSettingsView, ApplicationQueueAction, ApplicationQueueItem, ApplicationQueueStatus, ApplicationQueueView, ApplicationTraceView, ConnectionDeliveryList } from "../lib/types";
import type { PreparedApplicationTransferReceipt } from "../lib/applicationTransfer";

/**
 * The Applications tab (#958): the whole job-application queue across the owner's Scout → Tailor →
 * Runner pipeline, with typed actions. Every button posts ONE action to
 * `/application-queue/actions` — the same service the `applications` MCP tools call — carrying the
 * status and version it was read with, so a decision on something that changed meanwhile is refused.
 * The buttons shown are the ones the server says the item allows; the final-submit control appears
 * only when the Runner's policy allows an automatic submit for that application.
 */
/** Secret-free projection returned by the #1013 opaque handoff resolver. */
interface ApplicationHandoffView {
	id: string;
	runId: string;
	applicationId: string;
	state: string;
	expiresAt: string | null;
	reason: string | null;
}

export default function ApplicationsTab({ instanceId, isTailor = false }: { instanceId: string; isTailor?: boolean }) {
	const [searchParams] = useSearchParams();
	// Canonical #1013 links use query state so the existing `<tab>/<sessionId>` grammar remains
	// honest. The opaque value is no browser/profile identifier and is re-authorized by the API.
	const requestedHandoffId = searchParams.get("handoff")?.trim() || undefined;
	const requestedReconciliationHandoffId = searchParams.get("reconciliation_handoff")?.trim() || undefined;
	const requestedAnyHandoffId = requestedReconciliationHandoffId ?? requestedHandoffId;
	const reconciliationHandoff = !!requestedReconciliationHandoffId;
	// #1136: a notification about one application opens IT — its row selected, its decisions in view.
	const requestedApplicationId = searchParams.get("application")?.trim() || undefined;
	const focusApplied = useRef<string | null>(null);
	const [focusMissing, setFocusMissing] = useState(false);
	const detailRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<ApplicationQueueView | null>(null);
	const [error, setError] = useState("");
	const [filter, setFilter] = useState<ApplicationQueueStatus | "">("");
	const [open, setOpen] = useState<string | null>(null);
	const [handoff, setHandoff] = useState<ApplicationHandoffView | null>(null);
	const [handoffError, setHandoffError] = useState("");
	const [handoffOpen, setHandoffOpen] = useState(false);

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
	// The URL contains an opaque continuity id, not a run/profile/browser identifier. Resolve it
	// only after the owner is authenticated; the worker binds the result to this instance again.
	useEffect(() => {
		let cancelled = false;
		setHandoff(null);
		setHandoffError("");
		setHandoffOpen(false);
		if (!requestedAnyHandoffId) return;
		const resolved = reconciliationHandoff
			? api<ApplicationHandoffView>(`/v1/instances/${instanceId}/application-reconciliation-handoffs/${encodeURIComponent(requestedAnyHandoffId)}`)
			: api<ApplicationHandoffView>(`/v1/instances/${instanceId}/application-handoffs/${encodeURIComponent(requestedAnyHandoffId)}`);
		resolved
			.then((next) => { if (!cancelled) setHandoff(next); })
			.catch((e) => { if (!cancelled) setHandoffError(e instanceof Error ? e.message : String(e)); });
		return () => { cancelled = true; };
	}, [requestedAnyHandoffId, reconciliationHandoff, instanceId]);
	usePolling(load, 5000, !!view?.items.some((i) => i.status === "tailoring" || i.status === "filling" || i.fillRun));
	// Once per requested id, on the first loaded queue: later polls never take the owner's selection away.
	useEffect(() => {
		if (!view || !requestedApplicationId || focusApplied.current === requestedApplicationId) return;
		focusApplied.current = requestedApplicationId;
		const hit = view.items.find((i) => i.applicationId === requestedApplicationId);
		setFocusMissing(!hit);
		if (!hit) return;
		setFilter("");
		setOpen(hit.key);
		requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
	}, [view, requestedApplicationId]);

	if (error && !view) return <LoadFailed what="applications" detail={error} onRetry={load} />;
	if (!view) return <p className="text-sm text-muted">Loading applications…</p>;
	const items = filter ? view.items.filter((i) => i.status === filter) : view.items;
	const selected = view.items.find((i) => i.key === open) ?? null;

	return (
		<div className="max-w-4xl">
			{isTailor && <UploadedTailorSourcesSection instanceId={instanceId} />}
			{requestedAnyHandoffId && (
				<Card className="mb-3 sm:mb-4" data-testid="application-handoff">
					<h3 className="text-base font-bold">{reconciliationHandoff ? "Read-only application reconciliation" : "Application browser handoff"}</h3>
					{handoffError ? (
						<p className="text-sm text-danger mt-2" data-testid="application-handoff-unavailable">This handoff is unavailable: {handoffError}</p>
					) : !handoff ? (
						<p className="text-sm text-muted mt-2">Checking the exact owner-authorized Runner handoff…</p>
					) : (
						<>
							<p className="text-sm text-muted mt-2">
								{handoff.state === "active" ? reconciliationHandoff ? "Use this separate read-only browser only to sign in or complete the site challenge, then recheck. It cannot fill, upload, submit, or clear uncertainty without authoritative evidence." : "Use the existing Runner browser to complete the site step. Signing in does not by itself change an uncertain submission." : `This handoff is ${handoff.state.replace(/_/g, " ")}.`}
							</p>
							{handoff.reason && <p className="text-xs text-muted-soft mt-1">Reason: {handoff.reason.replace(/_/g, " ")}</p>}
							{handoff.expiresAt && <p className="text-xs text-muted-soft mt-1">Available until {new Date(handoff.expiresAt).toLocaleString()}.</p>}
							<div className="flex flex-wrap gap-2 mt-3">
								{handoff.state === "active" && <Button size="sm" variant="primary" onClick={() => setHandoffOpen(true)}>Take over live browser</Button>}
								{handoff.state !== "active" && <span className="text-xs text-muted">Closed or unavailable handoffs are not treated as completed submissions.</span>}
							</div>
						</>
					)}
				</Card>
			)}
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
				{view.health && !view.health.ok && (
					<ul className="mt-2 flex flex-col gap-1 text-xs text-warning" data-testid="application-pipeline-problems" aria-label="Pipeline problems">
						{view.health.problems.map((p) => (
							<li key={`${p.code}:${p.instanceId ?? p.connectionId ?? ""}`}>{p.message}</li>
						))}
					</ul>
				)}
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

			{focusMissing && (
				<p className="mb-3 text-sm text-muted" data-testid="application-focus-missing">
					The application this link is about is no longer in this queue — it may have been archived or removed.
				</p>
			)}
			<div ref={detailRef}>{selected && <Detail key={selected.key} instanceId={instanceId} item={selected} connections={view.connections} onChanged={load} />}</div>

			{view.pipeline.runners[0] && <SubmissionPolicy runnerId={view.pipeline.runners[0]} allowance={view.limits.find((l) => l.runnerInstanceId === view.pipeline.runners[0])} onChanged={load} />}
			{handoffOpen && handoff && (
				<ApplicationHandoffLive
					instanceId={instanceId}
					runId={handoff.runId}
					handoffId={handoff.id}
					reconciliation={reconciliationHandoff}
					onClose={() => setHandoffOpen(false)}
					onChanged={() => {
						setHandoffOpen(false);
						// Re-resolve rather than treating a local action as a terminal result. The next
						// status is the worker's durable, evidence-bound statement.
						if (requestedAnyHandoffId) {
							const resolved = reconciliationHandoff
								? api<ApplicationHandoffView>(`/v1/instances/${instanceId}/application-reconciliation-handoffs/${encodeURIComponent(requestedAnyHandoffId)}`)
								: api<ApplicationHandoffView>(`/v1/instances/${instanceId}/application-handoffs/${encodeURIComponent(requestedAnyHandoffId)}`);
							resolved.then(setHandoff).catch((e) => setHandoffError(e instanceof Error ? e.message : String(e)));
						}
						load();
					}}
				/>
			)}
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
					{l.autoSubmitEnabled ? (
						<span className="text-danger font-semibold" data-testid="auto-submit-status-on">⚠ Auto-submit ON — real applications are submitted automatically; {l.remaining} of {l.dailyCap} left today</span>
					) : (
						"Auto-submit: off — manual review (every application stops for your review)"
					)}
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

function Detail({ instanceId, item, connections, onChanged }: { instanceId: string; item: ApplicationQueueItem; connections: ApplicationQueueView["connections"]; onChanged: () => void }) {
	const [busy, setBusy] = useState<ApplicationQueueAction | "check" | null>(null);
	const [msg, setMsg] = useState("");
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [trace, setTrace] = useState<ApplicationTraceView | null>(null);
	const [transferConnection, setTransferConnection] = useState("");
	const pause = item.fillRun?.pause ?? null;
	// #988: the API's one durable, privacy-safe execution projection is authoritative. Keep the
	// legacy field as a read compatibility fallback for cards written before the projection existed.
	const progress = item.execution?.progress ?? item.fillProgress;
	const questions = pause?.question ? [pause.question] : item.questions;
	// #1063: the fill run's replay — every form control blurred by the runner before each frame was taken.
	const { artifacts, screenshotsOff } = useBrowserArtifacts(instanceId, "local_apply_run", item.fillRunId, item.stateVersion);
	const frames = useMemo(() => replayFrames(instanceId, artifacts), [instanceId, artifacts]);

	const act = async (action: ApplicationQueueAction) => {
		// #1073: an owner assertion carries the owner's own words; no words, no assertion.
		const statement = action === "assert_not_submitted" ? window.prompt(ASSERT_STATEMENT_PROMPT)?.trim() : undefined;
		if (action === "assert_not_submitted" && !statement) return;
		const ask = confirmText(action, item.status);
		if (ask && !window.confirm(ask)) return;
		setBusy(action);
		setMsg("");
		try {
			const given = questions.map((q) => ({ question: q, answer: (answers[q] ?? "").trim() })).filter((a) => a.answer);
			// `resume` answers serve that run only; `retry_tailoring` answers are saved to the owner's
			// Profile and read by every later Tailor run (#1066).
			const out = await api<ApplicationActionResponse>(`/v1/instances/${instanceId}/application-queue/actions`, { method: "POST", body: JSON.stringify(actionBody(item, action, { answers: action === "resume" || action === "retry_tailoring" ? given : undefined, statement })) });
			setMsg(`${actionLabel(action, item.status)}: now ${QUEUE_STATUS_LABEL[out.item.status].label}.`);
			onChanged();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
			onChanged();
		}
		setBusy(null);
	};
	// #1068: the read-only "was it sent?" check for an unconfirmed submit (#1013's reconciliation). It
	// asks the run's own Runner; when the site needs a sign-in or CAPTCHA first, it opens that bounded
	// read-only handoff. Nothing here can submit, retry, or clear the uncertainty.
	const navigate = useNavigate();
	const checkSubmission = async () => {
		const runner = item.execution?.currentRun?.kind === "fill" ? item.execution.currentRun.instanceId : instanceId;
		const base = `/v1/instances/${runner}/application-runs/${encodeURIComponent(item.fillRunId ?? "")}/reconciliation`;
		setBusy("check");
		setMsg("");
		try {
			const r = await api<ApplicationReconciliationResponse>(base, { method: "POST", body: "{}" });
			const handoff = checkNeedsOwner(r) ? await api<ApplicationReconciliationHandoffResponse>(`${base}/handoff`, { method: "POST", body: "{}" }) : null;
			const route = notificationRoute(handoff?.consoleLink);
			if (route) navigate(route);
			else setMsg(handoff ? "The site needs you to sign in, but the read-only browser could not be opened. Try again." : reconciliationSentence(r));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
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
	const pausedTransfers = item.status === "materials_ready" && item.tailorInstanceId ? connections.filter((c) => !c.enabled && c.sourceInstanceId === item.tailorInstanceId && c.eventType === "job.application.materials_ready" && c.action === "start_application_fill") : [];
	const transfer = async () => {
		const connection = pausedTransfers.find((c) => c.id === (transferConnection || pausedTransfers[0]?.id));
		const resume = item.artifacts?.resume;
		const cover = item.artifacts?.coverLetter;
		if (!connection || !resume || !cover || !item.applicationId || item.stateVersion === null) return;
		if (!window.confirm("Send this exact reviewed material set to the selected Runner for review only? The connection stays paused and nothing will be submitted.")) return;
		setBusy("request_review"); setMsg("");
		try {
			const out = await api<PreparedApplicationTransferReceipt>(`/v1/instances/${instanceId}/applications/${encodeURIComponent(item.applicationId)}/transfer`, { method: "POST", body: JSON.stringify({ expected_status: "materials_ready", expected_version: item.stateVersion, resume_sha256: resume.sha256, cover_letter_sha256: cover.sha256, destination_runner_instance_id: connection.targetInstanceId, connection_id: connection.id, idempotency_key: `transfer:${item.applicationId}:${item.stateVersion}:${connection.id}` }) });
			setMsg(`Reviewed transfer ${out.status}${out.runId ? ` (run ${out.runId.slice(0, 8)})` : ""}.`); onChanged();
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		setBusy(null);
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
			{pausedTransfers.length > 0 && item.artifacts?.resume && item.artifacts?.coverLetter && (
				<div className="mb-3 rounded border border-line p-2 text-sm" data-testid="reviewed-material-transfer">
					<p className="font-semibold">Transfer this reviewed set</p>
					<p className="text-xs text-muted mb-2">Send these exact hashes to one paused Runner for fill and review only. This does not resume the connection or submit an application.</p>
					<select aria-label="Runner for reviewed transfer" value={transferConnection || pausedTransfers[0].id} onChange={(e) => setTransferConnection(e.target.value)} className="border border-line rounded px-2 py-1 mr-2">
						{pausedTransfers.map((c) => <option key={c.id} value={c.id}>{c.targetInstanceId}</option>)}
					</select>
					<Button size="sm" onClick={transfer} disabled={busy !== null}>{busy === "request_review" ? "Transferring…" : "Transfer for review"}</Button>
				</div>
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
			{canCheckSubmission(item) && (
				<div className="mb-2">
					<Button size="sm" variant="primary" disabled={!!busy} onClick={() => void checkSubmission()} data-testid="check-submission">
						{busy === "check" ? "Checking…" : "Check the employer's site (read-only)"}
					</Button>
					<p className="text-xs text-muted mt-1">Your Runner looks at the site's application history without sending anything. If the site asks you to sign in, you do that in a read-only browser here.</p>
				</div>
			)}

			{(item.blockReason || pause) && (
				<div className="mb-2 text-sm">
					<p className="text-warning font-semibold">Waiting: {(pause?.reason ?? item.blockReason ?? "").replace(/_/g, " ")}</p>
					{pause?.url && <p className="text-xs text-muted">At {pause.url} — open the runner's browser window on your machine to handle it, then Resume.</p>}
					{questions.map((q) => (
						<div key={q} className="mt-1">
							<MarkdownText text={q} className="text-xs" />
							{(item.actions.includes("resume") || item.actions.includes("retry_tailoring")) && (
								<input aria-label={q} value={answers[q] ?? ""} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} className="w-full bg-paper border border-line rounded px-2 py-1 text-sm" placeholder="Your answer (leave empty to skip it)" />
							)}
						</div>
					))}
					{item.actions.includes("retry_tailoring") && questions.length > 0 && (
						<p className="text-xs text-muted mt-1">Answers you give with Retry tailoring are saved to your Profile and used by future tailoring, so the same question is not asked again.</p>
					)}
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

			{(frames.length > 0 || screenshotsOff) && (
				<div className="mt-3">
					<RunReplay frames={frames} emptyText={SCREENSHOTS_OFF_TEXT} />
				</div>
			)}

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
 * The handoff + submission policy (#953) — the Runner's settings. Manual review (fill-and-review) is
 * the default. Auto-submit is never a checkbox (#1039): it is turned on only through a confirmation
 * that shows the exact rules and requires the owner's acknowledgement that submissions are real and
 * irreversible (the server requires it too, as MCP's set_application_runner_settings does), and while
 * it is on a danger banner offers the one-click way out. The server's refusals are shown as they come.
 */
function SubmissionPolicy({ runnerId, allowance, onChanged }: { runnerId: string; allowance?: AutoSubmitAllowance | null; onChanged: () => void }) {
	const [s, setS] = useState<ApplicationRunnerSettingsView["settings"] | null>(null);
	const [draft, setDraft] = useState({ profile: "", answers: "", signInEmail: "", allowDomains: "", roles: "", locations: "", exclude: "", minSalary: "", dailyCap: "0" });
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [confirmError, setConfirmError] = useState("");
	const load = useCallback(async () => {
		try {
			const v = await api<ApplicationRunnerSettingsView>(`/v1/instances/${runnerId}/application-runner/settings`);
			setS(v.settings);
			const a = v.settings.autoSubmit;
			setDraft({ profile: v.settings.sources.profile ?? "", answers: v.settings.sources.answers ?? "", signInEmail: v.settings.signInEmail ?? "", allowDomains: v.settings.allowDomains.join(", "), roles: a.roles.join(", "), locations: a.locations.join(", "), exclude: a.exclude.join(", "), minSalary: a.minSalary === null ? "" : String(a.minSalary), dailyCap: String(a.dailyCap) });
			if (v.error) setMsg(v.error);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	}, [runnerId]);
	useEffect(() => {
		load();
	}, [load]);
	if (!s) return null;
	const draftRules: AutoSubmitRules = {
		allowDomains: list(draft.allowDomains),
		roles: list(draft.roles),
		locations: list(draft.locations),
		exclude: list(draft.exclude),
		minSalary: draft.minSalary.trim() ? Number(draft.minSalary) : null,
		dailyCap: Number(draft.dailyCap) || 0,
	};
	const savedRules: AutoSubmitRules = { allowDomains: s.allowDomains, ...s.autoSubmit };
	const put = async (body: Record<string, unknown>) => {
		await api(`/v1/instances/${runnerId}/application-runner/settings`, { method: "PUT", body: JSON.stringify(body) });
		await load();
		onChanged();
	};
	const save = async () => {
		setMsg("");
		try {
			await put({ ...rulesPayload(draftRules, { profile: draft.profile.trim() || null, answers: draft.answers.trim() || null }), signInEmail: draft.signInEmail.trim() || null });
			setMsg("Saved.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	const enable = async () => {
		setBusy(true);
		setConfirmError("");
		try {
			await put(enablePayload(draftRules));
			setConfirming(false);
			setMsg("Auto-submit is on.");
		} catch (e) {
			// The server's refusal as it is — a missing prerequisite, or the acknowledgement.
			setConfirmError(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};
	const disable = async () => {
		setBusy(true);
		try {
			await put(disablePayload());
			setMsg("Auto-submit is off. Every application stops for your review.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};
	const field = (key: keyof typeof draft, label: string, hint: string) => (
		<label className="flex flex-col gap-0.5 text-xs">
			<span className="font-semibold">{label}</span>
			<input value={String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className="bg-paper border border-line rounded px-2 py-1 text-sm" placeholder={hint} />
		</label>
	);
	return (
		<Card className="mt-3 sm:mt-4">
			{s.autoSubmit.enabled && <AutoSubmitDangerBanner rules={savedRules} allowance={allowance} onDisable={() => void disable()} busy={busy} />}
			<div className="flex flex-wrap items-center gap-2 mb-1">
				<h3 className="text-base font-bold">Submission policy</h3>
				{!s.autoSubmit.enabled && <ManualReviewBadge />}
			</div>
			<p className="text-sm text-muted mb-2">
				By default every application is filled on your machine and stops for your review — nothing is submitted. Auto-submit applies only to applications that match every rule below, up to the daily cap.
			</p>
			<div className="grid sm:grid-cols-2 gap-2 mb-2">
				{field("profile", "Profile file (in your workspace)", "profile.md")}
				{field("answers", "Answers file (optional)", "answers.md")}
				{field("signInEmail", "SEEK sign-in email (signs in with the emailed code)", "the address your SEEK account uses")}
				{field("allowDomains", "Allowed sites", "boards.greenhouse.io, jobs.lever.co")}
				{field("roles", "Approved roles", "engineer, developer")}
				{field("locations", "Approved locations (optional)", "Sydney, Remote")}
				{field("exclude", "Exclude when the job mentions", "contract, unpaid")}
				{field("minSalary", "Minimum salary (optional)", "120000")}
				{field("dailyCap", "Auto-submits per day", "0")}
			</div>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="primary" onClick={save}>
					Save rules
				</Button>
				{!s.autoSubmit.enabled && (
					<Button size="sm" variant="danger" onClick={() => { setAcknowledged(false); setConfirmError(""); setConfirming(true); }} data-testid="auto-submit-enable">
						Enable auto-submit…
					</Button>
				)}
			</div>
			{msg && <p className="text-xs mt-2">{msg}</p>}
			{confirming && (
				<AutoSubmitConfirmDialog
					rules={draftRules}
					allowance={allowance}
					acknowledged={acknowledged}
					onAcknowledge={setAcknowledged}
					onConfirm={() => void enable()}
					onCancel={() => setConfirming(false)}
					busy={busy}
					error={confirmError}
				/>
			)}
		</Card>
	);
}
