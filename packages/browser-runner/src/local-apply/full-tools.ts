import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
/** Opt-in native tools: no interpretation of page content or native schema rewriting. */
import type { BrowserTools } from "../local-browser/bridge.js";
import type { ApplyBridgeHost, ToolResult } from "./bridge.js";
import { applyTools } from "./tool-schemas.js";
import { decisionReason, parseDecision } from "./answer-decision.js";
import type { LocalApplyArtifactKind, LocalApplyTaskEnvelope } from "./contract.js";
import type { PreparedUpload } from "./documents.js";
import { RunnerInputError } from "../errors.js";

export const FULL_SUBMISSION_UNKNOWN = "Full native tool access: submission state is unverified. The supervised submission counter does not cover effects inside native tools or arbitrary code.";
type NativeTool = Awaited<ReturnType<BrowserTools["listTools"]>>[number];
const response = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
const TASK_TOOLS = new Set(["upload_artifact", "request_answer", "ready_for_review", "supervisor_checkpoint", "request_sign_in_code"]);

export function parseToolAccess(policy: Record<string, unknown>, instanceId: string): Pick<LocalApplyTaskEnvelope["policy"], "toolAccess" | "toolAccessAcceptance"> {
	if (policy.toolAccess !== undefined && policy.toolAccess !== "guarded" && policy.toolAccess !== "full") throw new RunnerInputError("Unsupported application tool access mode");
	if (policy.toolAccess !== "full") return { toolAccess: "guarded", toolAccessAcceptance: null };
	const a = policy.toolAccessAcceptance as Record<string, unknown> | undefined;
	if (a?.revision !== "full_playwright_v1" || a.instanceId !== instanceId || typeof a.acceptedBy !== "string" || !a.acceptedBy.trim() || typeof a.acceptedAt !== "string" || !Number.isFinite(Date.parse(a.acceptedAt))) throw new RunnerInputError("Full Playwright access requires an instance-bound owner acceptance receipt");
	return { toolAccess: "full", toolAccessAcceptance: { revision: "full_playwright_v1", instanceId, acceptedBy: a.acceptedBy, acceptedAt: a.acceptedAt } };
}

export class FullApplyTools {
	private inventory: NativeTool[] | null = null;
	calls = 0;
	private credentialOrigin: string | null = null;
	private submissionPage: object | null = null;
	private submissionUrl = "";
	constructor(private readonly browser: BrowserTools, private readonly host: ApplyBridgeHost, private readonly counts: () => { actions: number; filled: number; uploaded: number }, private readonly approve: (approved: boolean) => void) {}
	async listTools(): Promise<NativeTool[]> {
		this.inventory ??= await this.browser.listTools();
		return [...this.inventory, ...applyTools([], false).filter((t) => TASK_TOOLS.has(t.name)).map((t) => t.name === "supervisor_checkpoint" ? { ...t, description: "Request review of an uncertain decision under the configured escalation level, or obtain an immediate before_submit authorization. Routine initial and page-change checkpoints are optional in full mode." } : t.name === "upload_artifact" ? { ...t, description: "Select an approved, hash-verified document in the current upload input. Observe the website afterward to verify acceptance." } : t), {
			name: "request_sign_in", description: "Request authorized credential provisioning for the current observed sign-in origin. The broker offers supported existing-account credentials before owner handoff; you perform the sign-in with the provisioned placeholders. A pause is not proof that a human must act; inspect the returned credentials or concrete blocker. This tool does not implement password reset or account registration.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}, { name: "finish_sign_in", description: "Clear provisioned credentials after observing sign-in completed or abandoning sign-in. This records no independent proof of authentication.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }, {
			name: "submit_application", description: "Intentionally submit this application once, through the supervised authorization gate. Requires auto_submit authorization and an immediately preceding before_submit checkpoint. Supply a target from the latest snapshot. Native tools must not be used to evade this authorization.",
			inputSchema: { type: "object", properties: { ref: { type: "string" }, element: { type: "string" } }, required: ["ref"], additionalProperties: false },
		}];
	}
	async has(name: string): Promise<boolean> { await this.listTools(); return this.inventory!.some((tool) => tool.name === name); }
	async call(name: string, args: Record<string, unknown>, expectedOrigin?: string): Promise<ToolResult> {
		this.invalidateSubmission();
		this.calls++;
		const names = new Set(this.host.signInSecrets?.() ?? []);
		const usesSecret = name === "browser_type" && names.has(String(args.text)) || name === "browser_fill_form" && Array.isArray(args.fields) && args.fields.some((field) => field && typeof field === "object" && names.has(String(field.value)));
		const origin = usesSecret ? this.credentialOrigin ?? expectedOrigin : undefined;
		const selected: Array<PreparedUpload & { kind: LocalApplyArtifactKind }> = [];
		if ((name === "browser_file_upload" || name === "browser_drop") && Array.isArray(args.paths) && args.paths.length) {
			for (const requested of args.paths) {
				let match: (PreparedUpload & { kind: LocalApplyArtifactKind }) | undefined;
				for (const kind of ["resume", "cover_letter"] as const) {
					const approved = this.host.artifactPath(kind);
					if ("error" in approved) continue;
					try { if (typeof requested === "string" && realpathSync(this.host.resolveUploadPath ? this.host.resolveUploadPath(requested) : isAbsolute(requested) ? requested : "") === realpathSync(approved.path) && extname(approved.path).toLowerCase() === ".pdf") match = { ...approved, kind }; } catch { /* The native identity guard will also refuse an unavailable path. */ }
				}
				if (!match) return response("Only approved, hash-verified PDF artifacts may be selected. No file upload was dispatched.", true);
				selected.push(match);
			}
		}
		const result = await this.browser.callTool(name, args, origin ? { expectedOrigin: origin } : undefined);
		if (!result.isError) for (const file of selected) this.host.emit({ type: "artifact.uploaded", detail: { kind: file.kind, sha256: file.sha256, ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256, rendererRevision: file.rendererRevision, mimeType: file.mimeType, bytes: file.bytes } : {}), class: "fill", status: "selected", reason: "site_acceptance_unconfirmed" } });
		// Preserve every native content block, including screenshot pixels. Do not relabel calls as fills.
		return { ...result, content: result.content ?? [] } as ToolResult;
	}
	async checkpoint(args: Record<string, unknown>): Promise<ToolResult> {
		const checkpointId = typeof args.checkpointId === "string" ? args.checkpointId : "";
		const phase = args.phase;
		if (!/^[A-Za-z0-9_.:-]{1,300}$/.test(checkpointId) || phase !== "initial" && phase !== "post_navigation" && phase !== "before_submit" && phase !== "uncertain") return response("Supply a valid checkpointId and phase.", true);
		const decision = args.decision === undefined ? null : parseDecision(args.decision);
		if (args.decision !== undefined && !decision || phase === "uncertain" && !decision) return response("An uncertainty checkpoint requires decision {risk, reason}.", true);
		const page = this.host.page?.(); const url = page?.url?.();
		const directive = await this.host.supervisorCheckpoint({ schemaVersion: 1, checkpointId, facts: { phase, ...this.counts(), blockers: [], ...(url ? { url } : {}), ...(decision ? { decision: { ...decision, reason: decisionReason(decision.reason, this.host.redact) } } : {}) } });
		const approved = directive === "continue" && !this.host.isStopped?.() && !!page && this.host.page?.() === page && page.url?.() === url;
		this.approve(approved && phase === "before_submit");
		this.submissionPage = approved && phase === "before_submit" ? page : null; this.submissionUrl = url ?? "";
		return response(`Supervisor directive: ${directive}. ${directive === "continue" ? "Continue within this run's task and submission authorization." : "Stop now."}`, directive !== "continue");
	}
	invalidateSubmission(): void { this.approve(false); this.submissionPage = null; }
	async signIn(): Promise<ToolResult> {
		if (this.credentialOrigin) this.finishSignIn();
		const page = this.host.page?.(); const url = page?.url?.();
		if (!url || !/^https?:/.test(url)) return response("A current website page is required for sign-in.", true);
		const origin = new URL(url).origin;
		const outcome = await this.host.pause({ reason: "login_required", url, domain: new URL(url).hostname });
		if (outcome === "stopped" || this.host.isStopped?.()) return response("Sign-in stopped.", true);
		if (outcome === "sign_in") {
			if (this.host.page?.() !== page || new URL(page!.url!()).origin !== origin) { this.host.signInDone?.(); return response("The credential origin changed. Request sign-in again from the current page.", true); }
			this.credentialOrigin = origin;
			return response(`Authorized credential origin: ${origin}. Provisioned names: ${(this.host.signInSecrets?.() ?? []).join(", ")}. Type these names with native browser_type or browser_fill_form. Values are substituted only at this origin. Observe sign-in and call finish_sign_in afterward.`);
		}
		return response("The owner resumed. Inspect the current page to determine sign-in state.");
	}
	async signInCode(): Promise<ToolResult> {
		if (!this.credentialOrigin) return response("No authorized sign-in is active. Call request_sign_in first.", true);
		const url = this.host.page?.()?.url?.();
		if (!url || new URL(url).origin !== this.credentialOrigin || this.host.isStopped?.()) { this.finishSignIn(); return response("Sign-in origin changed or the run stopped. No code requested.", true); }
		const ok = await this.host.requestSignInCode?.();
		const after = this.host.page?.()?.url?.();
		if (!after || new URL(after).origin !== this.credentialOrigin || this.host.isStopped?.()) { this.finishSignIn(); return response("Sign-in origin changed or the run stopped. Provisioned credentials cleared.", true); }
		return response(ok ? "PAGS_LOGIN_CODE is provisioned for the bound origin. Type that name, then observe the result." : "No sign-in code was provisioned.", !ok);
	}
	finishSignIn(): ToolResult { this.credentialOrigin = null; this.host.signInDone?.(); return response("Provisioned credentials cleared. Authentication state remains a model observation."); }
	canSubmit(): boolean { return !!this.submissionPage && this.host.page?.() === this.submissionPage && this.host.page?.()?.url?.() === this.submissionUrl; }
}

/** Approved legacy documents are copied into this run; every selection rechecks provenance and bytes. */
export function fullArtifactPaths(original: ApplyBridgeHost["artifactPath"], kinds: LocalApplyTaskEnvelope["artifacts"], runDir: string): ApplyBridgeHost["artifactPath"] {
	const requestedDirectory = join(runDir, "native-documents"); mkdirSync(requestedDirectory, { mode: 0o700 });
	const directory = realpathSync(requestedDirectory);
	const paths = new Map<string, string>();
	for (const { kind } of kinds) {
		const approved = original(kind); if ("error" in approved) throw new RunnerInputError(approved.error);
		if (extname(approved.path).toLowerCase() !== ".pdf") throw new RunnerInputError("A real PDF attachment is required; text-file upload fallback is disabled.");
		const path = join(directory, `${kind}${extname(approved.path)}`); writeFileSync(path, readFileSync(approved.path), { mode: 0o600, flag: "wx" }); paths.set(kind, path);
	}
	return (kind) => {
		const approved = original(kind); if ("error" in approved) return approved;
		const path = paths.get(kind); if (!path) return { error: "No approved document of this kind." };
		try {
			if (!lstatSync(path).isFile() || realpathSync(path) !== path || createHash("sha256").update(readFileSync(path)).digest("hex") !== approved.sha256) return { error: "The run document changed; upload refused." };
			return { ...approved, path };
		} catch { return { error: "The approved run document is unavailable." }; }
	};
}
