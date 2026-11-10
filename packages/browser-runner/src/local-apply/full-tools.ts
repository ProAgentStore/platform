import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
/** Opt-in native tools: no interpretation of page content or native schema rewriting. */
import type { BrowserTools } from "../local-browser/bridge.js";
import { signInQuestion, type ApplyBridgeHost, type ToolResult } from "./bridge.js";
import { siteKeyOf } from "./site-session.js";
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

/** Read-only observation keeps the before_submit approval and the latest snapshot; canSubmit() rechecks page and URL at submit time (#1628). */
export const OBSERVATION_TOOLS = new Set(["browser_snapshot", "browser_find", "browser_take_screenshot"]);
const DESTRUCTIVE_VERB = /\b(delete|remove|erase|discard)\b/i;
const RESUME = "r[eé]sum[eé]?s?|cv|cover letters?";
/** The page itself says a site-side storage limit was hit (SEEK: "Resumé limit reached", `#docLimitExceededDropdown`). */
export const STORAGE_LIMIT_CUE = /(limit (reached|exceeded)|docLimit|maximum number of (r[eé]sum|documents?))/i;
const STORED_ITEM_CUE = new RegExp(`\\b(selected|saved|stored|existing|default|my|your)\\b.{0,20}\\b(${RESUME}|profile|documents?)\\b|\\b(${RESUME}) (list|library)\\b|\\b(from|in) (your|my) (account|profile|list)\\b|docLimit`, "i");

/**
 * A click or select that deletes data stored on the owner's job-site account (a saved résumé, profile entry),
 * not an attachment on the current form. The label must name a stored item, or the page must have shown a
 * storage-limit dialog (`limitShown`). The owner chooses what to delete, never the model (#1626).
 */
export function isAccountStorageDeletion(name: string, args: Record<string, unknown>, targetName: string, limitShown: boolean): boolean {
	if (name !== "browser_click" && name !== "browser_select_option") return false;
	const label = [args.element, targetName].filter((v): v is string => typeof v === "string").join(" ");
	const ref = typeof args.target === "string" ? args.target : typeof args.ref === "string" ? args.ref : "";
	if (!DESTRUCTIVE_VERB.test(label)) return false;
	return limitShown || STORED_ITEM_CUE.test(`${label} ${ref}`);
}

export class FullApplyTools {
	private inventory: NativeTool[] | null = null;
	calls = 0;
	private credentialOrigin: string | null = null;
	private submissionPage: object | null = null;
	private submissionUrl = "";
	constructor(private readonly browser: BrowserTools, private readonly host: ApplyBridgeHost, private readonly counts: () => { actions: number; filled?: number; uploaded: number }, private readonly approve: (approved: boolean) => void, private readonly setBlocked: (blocked: { reason: "login_required"; questions: string[] } | null) => void) {}
	async listTools(): Promise<NativeTool[]> {
		this.inventory ??= await this.browser.listTools();
		return [...this.inventory, ...applyTools([], false).filter((t) => TASK_TOOLS.has(t.name)).map((t) => t.name === "supervisor_checkpoint" ? { ...t, description: "Request review of an uncertain decision under the configured escalation level, or obtain an immediate before_submit authorization. Routine initial and page-change checkpoints are optional in full mode." } : t.name === "upload_artifact" ? { ...t, description: "Select an approved, hash-verified document in the current upload input. Observe the website afterward to verify acceptance." } : t), {
			name: "request_sign_in", description: "Request authorized credential provisioning for the current observed sign-in origin. The broker answers at once with what it holds for this site: a saved login, or the account address and no password. You perform the sign-in with the provisioned placeholders. A pause is not proof that a human must act; inspect the returned credentials or concrete blocker.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}, ...(this.host.accountOperations ? [{
			name: "request_new_password", description: "Only for registering an account or resetting a password at the active sign-in origin. Provisions PAGS_NEW_PASSWORD, a generated password the broker has already recorded as pending in the vault. Type that name into the new-password fields. It is issued once per run.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}, {
			name: "request_sign_in_link", description: "Reads the fresh reset or verification link the site emailed to the account address and opens it in the current page. The link is never shown to you. Call after the site says it sent one, then observe the page. Once per run.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}] : []), { name: "finish_sign_in", description: "Clear provisioned credentials after observing sign-in completed or abandoning sign-in. Pass signedIn: true only when you observed the authenticated account; that confirms a pending new password into the vault. This records no independent proof of authentication.", inputSchema: { type: "object", properties: { signedIn: { type: "boolean" } }, additionalProperties: false } }, {
			name: "submit_application", description: "Intentionally submit this application once, through the supervised authorization gate. Requires auto_submit authorization and an immediately preceding before_submit checkpoint. Supply a target from the latest snapshot. Native tools must not be used to evade this authorization.",
			inputSchema: { type: "object", properties: { ref: { type: "string" }, element: { type: "string" } }, required: ["ref"], additionalProperties: false },
		}];
	}
	async has(name: string): Promise<boolean> { await this.listTools(); return this.inventory!.some((tool) => tool.name === name); }
	async call(name: string, args: Record<string, unknown>, expectedOrigin?: string): Promise<ToolResult> {
		if (!OBSERVATION_TOOLS.has(name)) this.invalidateSubmission();
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
		const domain = new URL(url).hostname;
		// Like the structured pauseFor: a pause that never resolves (the CLI gave up, the run ended) is a login_required block.
		this.setBlocked({ reason: "login_required", questions: [signInQuestion(siteKeyOf(domain))] });
		const outcome = await this.host.pause({ reason: "login_required", url, domain });
		if (outcome === "stopped" || this.host.isStopped?.()) return response("Sign-in stopped.", true);
		this.setBlocked(null);
		if (outcome === "sign_in") {
			if (this.host.page?.() !== page || new URL(page!.url!()).origin !== origin) { this.host.signInDone?.(); return response("The credential origin changed. Request sign-in again from the current page.", true); }
			this.credentialOrigin = origin;
			const names = this.host.signInSecrets?.() ?? [];
			const saved = names.includes("PAGS_LOGIN_PASSWORD");
			const next = saved ? "" : this.host.accountOperations
				? " PAGS holds no saved password for this site. The owner has authorized account registration and password reset for this run: decide from the live page whether the account exists. If it does not, register it; if it does, use the site's own password recovery. Call request_new_password for the new password and request_sign_in_link for an emailed reset or verification link (request_sign_in_code for a numeric code). Never register again when the site says the account exists."
				: " PAGS holds no saved password for this site and registration or password reset is not authorized for this run; report that and hand sign-in to the owner.";
			return response(`Authorized credential origin: ${origin}. Provisioned names: ${names.join(", ")}. Type these names with native browser_type or browser_fill_form. Values are substituted only at this origin.${next} Observe sign-in and call finish_sign_in afterward.`);
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
	/** The sign-in is still the same origin and the run is live; else it is cleared and the caller returns the refusal. */
	private signInActive(): string | null {
		const url = this.host.page?.()?.url?.();
		if (!this.credentialOrigin) return "No authorized sign-in is active. Call request_sign_in first.";
		if (!url || new URL(url).origin !== this.credentialOrigin || this.host.isStopped?.()) { this.finishSignIn(); return "Sign-in origin changed or the run stopped. Provisioned credentials cleared."; }
		return null;
	}
	async newPassword(): Promise<ToolResult> {
		if (!this.host.accountOperations) return response("Account registration and password reset are not authorized for this run.", true);
		const refused = this.signInActive(); if (refused) return response(refused, true);
		const ok = await this.host.requestNewPassword?.();
		return response(ok ? "PAGS_NEW_PASSWORD is provisioned for the bound origin and recorded as pending in the vault. Type that name into the new-password fields, then observe the result. It is issued once per run." : "No new password was provisioned. Do not invent one; report the blocker and hand sign-in to the owner.", !ok);
	}
	async signInLink(): Promise<ToolResult> {
		if (!this.host.accountOperations) return response("Account registration and password reset are not authorized for this run.", true);
		const refused = this.signInActive(); if (refused) return response(refused, true);
		const ok = await this.host.openSignInLink?.();
		if (!ok) return response("No matching link was opened. A fresh account-matched link may not have arrived, or one was already used this run. Do not request another reset until you have observed the site; report the blocker if none arrives.", true);
		const url = this.host.page?.()?.url?.();
		// A link on another origin of the same site keeps the secrets bound to the origin the agent is now on.
		if (url && /^https?:/.test(url)) this.credentialOrigin = new URL(url).origin;
		return response("The emailed link was opened in the current page. Observe the page and continue; PAGS_NEW_PASSWORD is bound to the page's origin.");
	}
	finishSignIn(signedIn = false): ToolResult {
		const url = this.host.page?.()?.url?.();
		// The model's own observation of the authenticated account: the broker confirms a pending new password on it. Not independent proof.
		if (signedIn && this.credentialOrigin) this.host.emit({ type: "policy.decision", ...(url && /^https?:/.test(url) ? { domain: new URL(url).hostname } : {}), detail: { tool: "agent_sign_in", class: "session", decision: "signed_in", basis: "model_observed" } });
		this.credentialOrigin = null; this.host.signInDone?.();
		return response("Provisioned credentials cleared. Authentication state remains a model observation.");
	}
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
		const path = join(directory, basename(approved.path)); writeFileSync(path, readFileSync(approved.path), { mode: 0o600, flag: "wx" }); paths.set(kind, path);
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
