import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { attachAudit, auditStepEntry, capStepOutput, coverageShortfall, executePipelineStep, partialFailure, stepBind, type AuditEntry, type PipelineDef, type StepResult } from "../lib/pipeline.js";
import { logError } from "../lib/error-log.js";
import { logEvent } from "../lib/events.js";
import { closeRun } from "../lib/pipeline-runs.js";
import { isTransientInfraError } from "../lib/transient-error.js";
import type { Env } from "../types.js";

export interface PipelineRunParams {
	instanceId: string;
	userId: string;
	/** The pipeline definition to run (resolved by the caller from instance config). */
	pipeline: PipelineDef;
	/** Run parameters (from chat args, the trigger payload, or the API body). */
	params?: Record<string, unknown>;
	/** Groups all trace events for this run. */
	runId: string;
	/** How the run was started, for the audit trail. */
	trigger?: "chat" | "api" | "trigger";
	/** The ONE delegation pool this run's steps draw against (#382), when it needs one. Opened at
	 *  kick (`pipeline-run-start.ts`) so it survives a resume — a pool re-opened mid-run would be
	 *  the per-call copy this fixes, arrived at from the other side. */
	budgetId?: string;
	/** The agent's declared tool allowlist (#381), resolved once at kick and journaled with the
	 *  params — so the gate costs no read per step, and a capability change mid-run cannot make
	 *  the walk non-deterministic on resume. */
	declaredTools?: string[];
}

export interface PipelineRunResult {
	outcome: "completed" | "failed";
	steps: number;
	sunk?: number;
	detail?: string;
}

/**
 * The durable pipeline runner (issue #97). Walks a declarative pipeline's steps IN ORDER,
 * each in its own `step.do` so the run is durable + resumable past the 30s DO limit — the
 * same machinery as JobApplyWorkflow / CodingSessionWorkflow. Each step dispatches its
 * registry tool through runRegistryTool (inside executePipelineStep), so connector
 * auth/grant/consent (#86/#90) are enforced identically to a direct tool call. Outputs
 * thread between steps by `bind`; the final bound output feeds the optional `sink`.
 *
 * Resume-determinism caveat (mirrors job-apply): connector tokens are re-minted INSIDE each
 * step.do (runRegistryTool → connectorClient runs per step) and NEVER captured across steps,
 * so a resume after an isolate reset re-authenticates rather than replaying a stale token.
 * The step call order is deterministic (linear walk, stable `s{i}` names), so replay is
 * stable.
 */
/**
 * Steps that PERSIST rows themselves and return a counts summary rather than records.
 *
 * A pipeline ending in one of these has already done the writing, so the `sink` must stand down —
 * and the run's counts come from what it reports, not from a fabricated `seen: 1, added: 1`.
 */
const PERSISTING_TOOLS = new Set(["dedupe_upsert"]);

interface PersistCounts {
	total: number;
	inserted: number;
	updated: number;
	skipped: number;
}

/** The counts a persisting final step reported, or null when the last step wasn't one. */
function persistSummary(tool: string | undefined, out: unknown): PersistCounts | null {
	if (!tool || !PERSISTING_TOOLS.has(tool)) return null;
	if (!out || typeof out !== "object" || Array.isArray(out)) return null;
	const o = out as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return { total: num(o.total), inserted: num(o.inserted), updated: num(o.updated), skipped: num(o.skipped) };
}

export class PipelineRunWorkflow extends WorkflowEntrypoint<Env, PipelineRunParams> {
	async run(event: WorkflowEvent<PipelineRunParams>, step: WorkflowStep): Promise<PipelineRunResult> {
		const { instanceId, userId, pipeline, params = {}, runId, trigger = "api", budgetId, declaredTools } = event.payload;
		const env = this.env;
		// Run counts (issue #98) — captured as the runner walks, closed onto the run record.
		let seen = 0;
		let added = 0;
		let skipped = 0;
		let updated = 0;
		let errors = 0;
		try {
			await step.do("trace-start", async () => {
				await logEvent(env, { source: "pipeline", event: "pipeline.start", message: `Run "${pipeline.name}" (${trigger})`, userId, instanceId, traceId: runId, context: { pipeline: pipeline.name, steps: pipeline.steps.length, trigger } }).catch(() => undefined);
				return null;
			});

			// Bound outputs accumulate across steps; NOT captured across step.do closures as a
			// mutable token — the value written here is journaled by the Workflow and replayed
			// deterministically on resume. Connector auth is re-minted per step (see caveat).
			const outputs: Record<string, unknown> = {};
			let lastOutput: unknown = null;
			// Per-record audit trail (issue #98): one entry per step's decision, accumulated as
			// the runner walks, then attached to each output record before the sink persists it.
			const trail: AuditEntry[] = [{ step: "input", detail: `run "${pipeline.name}" (${trigger}) with ${Object.keys(params).length} param(s)`, at: new Date().toISOString() }];
			// What a bounding step left unexamined, carried to the run's own detail line so the
			// console says "capped" where it says how the run went — a warn event alone is only
			// found by someone who already suspects something.
			const shortfalls: string[] = [];
			// What a step failed on while still succeeding overall (#642, #630) — carried to the
			// detail line for the same reason a cap is: it is the part of "how did this run go" that
			// the counts alone cannot express, and `errors: 12` without a cause is not debuggable.
			const partials: string[] = [];

			for (let i = 0; i < pipeline.steps.length; i++) {
				const s = pipeline.steps[i];
				const bind = stepBind(s, i);
				// Each step is a durable unit. On failure the runner records it and stops (a
				// clean seam: #96's step library can add per-step retry/continue policy here).
				// step.do requires a Serializable return; a step's `output` is arbitrary tool JSON
				// (typed `unknown`), which doesn't satisfy that constraint at compile time even
				// though it's plain JSON at runtime. Route the callback through `unknown` and cast
				// the journaled result back to StepResult — same escape hatch job-apply uses.
				const result = (await step.do(`s${i}-${s.tool}`, async () =>
					capStepOutput(
						(await executePipelineStep({ env, userId, instanceId, traceId: runId, budgetId, declaredTools }, s, i, outputs, params)) as unknown as StepResult,
						s.tool,
						i,
					) as unknown as Record<string, string>,
				)) as unknown as StepResult;
				outputs[bind] = result.output;
				lastOutput = result.output;
				// Capture this step's DECISION onto the trail (first-class, not reconstructed).
				trail.push(auditStepEntry(s, i, result));
				// A cap that fired is a COVERAGE fact, not a step outcome: the step succeeded, and
				// without this the run reports a tidy completed sweep of a city it only partly
				// looked at. Logged where a reader already is (the trace + the run's detail line).
				const shortfall = coverageShortfall(s.tool, result.output);
				if (shortfall) {
					shortfalls.push(shortfall);
					trail.push({ step: `step ${i}: coverage`, detail: shortfall, at: new Date().toISOString() });
					await step.do(`s${i}-capped`, async () => {
						await logEvent(env, { source: "pipeline", event: "pipeline.capped", level: "warn", message: shortfall, userId, instanceId, traceId: runId, context: { step: i, tool: s.tool, bind } }).catch(() => undefined);
						return null;
					});
				}
				// A step that succeeded on MOST of its records reported the failures in its own JSON
				// body, behind a pretty-printed `items` array the 160-character trace excerpt never
				// reaches — so a run where 40 of 83 probes hard-failed read as a normal step and a
				// `completed / errors: 0` run row. The step's own count and the run's `errors`
				// disagreed, and only the unreadable one was right (#642, #630).
				const partial = partialFailure(s.tool, result.output, result.dispatched ? `${s.tool} → ${result.dispatched}` : s.tool);
				if (partial) {
					errors += partial.failed;
					partials.push(partial.note);
					trail.push({ step: `step ${i}: partial failure`, detail: partial.note, at: new Date().toISOString() });
					await step.do(`s${i}-partial`, async () => {
						// `context` is where the numbers go: unlike `message`, it is not truncated, so
						// `firstError` — the one string that says WHAT went wrong — survives.
						await logEvent(env, { source: "pipeline", event: "pipeline.partial", level: "warn", message: partial.note.slice(0, 400), userId, instanceId, traceId: runId, context: { step: i, tool: s.tool, ...(result.dispatched ? { dispatched: result.dispatched } : {}), bind, failed: partial.failed, total: partial.total, firstError: partial.firstError } }).catch(() => undefined);
						return null;
					});
				}
				// What a step NAMES is not always what it RAN (#396): `enrich` dispatches a tool from
				// its own inputs, and the trace carried `tool: "enrich"` and nothing else — so the
				// #394 audit had to infer the inner tool from the shape of the data it left behind.
				// One extra field, resolved once per step in `executePipelineStep`.
				const ran = result.dispatched ? `${s.tool} → ${result.dispatched}` : s.tool;
				await step.do(`s${i}-trace`, async () => {
					await logEvent(env, { source: "pipeline", event: "pipeline.step", level: result.success ? "info" : "warn", message: `${ran} → ${bind}: ${result.content.slice(0, 160)}`, userId, instanceId, traceId: runId, context: { step: i, tool: s.tool, ...(result.dispatched ? { dispatched: result.dispatched } : {}), bind, success: result.success } }).catch(() => undefined);
					return null;
				});
				if (!result.success) {
					errors++;
					// Per-step error with input context (issue #98) into the error store so a
					// failed step is debuggable — which step, what input reference shape.
					await step.do(`s${i}-error`, async () => {
						await logError(env, { source: "pipeline-step", userId, status: 500, message: `step ${i} (${ran}) failed: ${result.content.slice(0, 200)}`, context: { instanceId, runId, pipeline: pipeline.name, step: i, tool: s.tool, dispatched: result.dispatched, bind, inputs: s.inputs } }).catch(() => undefined);
						return null;
					});
					await step.do("trace-fail", async () => {
						await logEvent(env, { source: "pipeline", event: "pipeline.end", level: "warn", message: `Failed at step ${i} (${s.tool}): ${result.content.slice(0, 160)}`, userId, instanceId, traceId: runId, context: { failedStep: i, tool: s.tool } }).catch(() => undefined);
						return null;
					});
					const detail = `step ${i} (${s.tool}) failed: ${result.content.slice(0, 200)}`;
					await step.do("run-close-fail", async () => {
						// NOT best-effort: `closeRun` is the only terminal write to `pipeline_runs`.
						// Swallowed inside the step, the step reported SUCCESS and the run row stayed
						// `running` forever while the workflow returned a terminal outcome — the console
						// showed a run that never ends. Let the durable step retry instead.
						await closeRun(env, runId, "failed", { seen, added, skipped, errors }, detail);
						return null;
					});
					return { outcome: "failed", steps: i + 1, detail };
				}
			}

			// Optional sink: upsert the final step's output into an instance collection (#91)
			// via the AgentDO's records route — the same DO-fetch pattern job-apply uses to
			// reach the instance. Each record is its own durable step so a large sink resumes
			// mid-write. Dedupe/upsert-by-key is #96's job; here we insert.
			let sunk = 0;
			const persisted = persistSummary(pipeline.steps[pipeline.steps.length - 1]?.tool, lastOutput);
			if (persisted) {
				// The last step ALREADY wrote the records (dedupe_upsert), and its output is a
				// counts summary, not rows. Sinking it wrapped that summary in an array and POSTed
				// it as a record; `validateRecord` then dropped every field as unknown to the
				// collection's schema, so **every run of all three shipped pipelines inserted one
				// blank row** — accumulating toward MAX_COLLECTION_RECORDS — and reported
				// `seen: 1, added: 1` whether the sweep found 0 leads or 200.
				seen = persisted.total;
				// `added` means NET-NEW. Folding `updated` in to stop site-deploy reporting
				// `added: 0` broke the primary shipped pipeline instead: lead-finder upserts with
				// `mode:"update"`, so a re-sweep counted every pre-existing lead as added and the
				// run row claimed 200 added when 0 were new — destroying the one signal that says
				// whether the sweep found anything. The update count goes in the detail line.
				added = persisted.inserted;
				updated = persisted.updated;
				skipped += persisted.skipped;
			} else if (pipeline.sink) {
				const raw = Array.isArray(lastOutput) ? lastOutput : lastOutput != null ? [lastOutput] : [];
				seen = raw.length;
				const collection = pipeline.sink.collection;
				// Attach the captured audit trail to each record so the sink persists it and the
				// /data tab detail can show "what the pipeline saw + decided" per output record.
				const records = attachAudit(raw, trail, collection);
				skipped += raw.length - records.length;
				for (let r = 0; r < records.length; r++) {
					const rec = records[r];
					const ok = await step.do(`sink-${r}`, async () => {
						const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
						const res = await stub.fetch(new Request(`https://agent/collections/${encodeURIComponent(collection)}/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: rec }) }));
						if (!res.ok) {
							// Per-record sink error with context (issue #98) — captured, then this
							// record is skipped so one bad row can't fail the whole run.
							await logError(env, { source: "pipeline-sink", userId, status: res.status, message: `sink insert failed (${res.status}): ${(await res.text()).slice(0, 160)}`, context: { instanceId, runId, pipeline: pipeline.name, collection, record: r } }).catch(() => undefined);
							return false;
						}
						return true;
					});
					if (ok) sunk++;
					else errors++;
				}
				added = sunk;
			} else {
				seen = Array.isArray(lastOutput) ? lastOutput.length : lastOutput != null ? 1 : 0;
			}

			await step.do("trace-end", async () => {
				await logEvent(env, { source: "pipeline", event: "pipeline.end", message: `Completed "${pipeline.name}": ${pipeline.steps.length} step(s)${pipeline.sink ? `, ${sunk} → ${pipeline.sink.collection}` : ""}`, userId, instanceId, traceId: runId, context: { steps: pipeline.steps.length, sunk, seen, added, skipped, errors } }).catch(() => undefined);
				return null;
			});
			await step.do("run-close-ok", async () => {
				// `updated` rides in the DETAIL, so an update-only pipeline reads as work done without
				// inflating `added` (which means net-new) for the sweeps that re-see everything.
				const persisted = updated ? `, ${updated} updated` : "";
				const sinkNote = pipeline.sink ? `, ${added} → ${pipeline.sink.collection}${persisted}` : persisted;
				// The cap rides in the detail for the same reason `updated` does: it is the part of
				// "how did this run go" the counts cannot express. `seen` counts what was EXAMINED,
				// so without this line a capped sweep of Sydney and a complete sweep of Hobart read
				// identically — the run says it covered everything when it covered the first N.
				const capNote = shortfalls.length ? `; ${shortfalls.join("; ")}` : "";
				const partialNote = partials.length ? `; ${partials.join("; ")}` : "";
				// NOT best-effort — see `run-close-fail`. Reporting `{outcome:"completed"}` from a step
				// that failed to record the completion is the exact "success without the work" shape.
				await closeRun(env, runId, "completed", { seen, added, skipped, errors }, `${pipeline.steps.length} step(s)${sinkNote}${capNote}${partialNote}`);
				return null;
			});
			return { outcome: "completed", steps: pipeline.steps.length, sunk };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// A DO/isolate reset from a deploy is TRANSIENT — re-throw so the Workflow retries
			// + resumes from its last completed step (same as job-apply); don't manufacture a
			// crash on every deploy. Mark the run interrupted (not failed) so the row reflects
			// reality; the resume will re-close it terminally.
			if (isTransientInfraError(msg)) {
				await logEvent(env, { source: "pipeline", event: "pipeline.interrupted", message: `pipeline interrupted by a deploy, resuming: ${msg}`.slice(0, 200), userId, instanceId, traceId: runId }).catch(() => undefined);
				await closeRun(env, runId, "interrupted", { seen, added, skipped, errors }, msg.slice(0, 200)).catch(() => undefined);
				throw err;
			}
			await logError(env, { source: "pipeline-run", userId, status: 500, message: `pipeline "${pipeline.name}" crashed: ${msg}`, context: { instanceId, runId, pipeline: pipeline.name, stack: err instanceof Error ? String(err.stack || "").slice(0, 1500) : undefined } });
			// Swallowed deliberately — throwing from the crash handler would replace the real cause
			// with a bookkeeping error. But a failed close leaves the row `running` forever, so it
			// gets its own durable entry rather than disappearing behind the crash it followed.
			await closeRun(env, runId, "failed", { seen, added, skipped, errors: errors + 1 }, msg.slice(0, 200)).catch((e) =>
				logError(env, {
					source: "pipeline-run",
					userId,
					status: 500,
					message: `could not close run ${runId} after a crash — the row will stay 'running': ${e instanceof Error ? e.message : String(e)}`,
					context: { instanceId, runId, pipeline: pipeline.name },
				}).catch(() => undefined),
			);
			return { outcome: "failed", steps: 0, detail: msg };
		}
	}
}
