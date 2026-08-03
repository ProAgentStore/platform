import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, jsonText, text } from "../http.js";
import { audit, dryRun, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/** Apply-agent tools — gated to users who have a job-application agent. */
export function registerApplyTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor, groups } = ctx;
	// ── Apply-agent tools — only for users who have a job-application agent ──
	if (groups.has("apply")) {
	server.tool(
		"upload_resume",
		"Upload/replace the candidate's résumé for a private apply-agent instance (from a public URL or a base64 PDF), OR — with NO url/content_base64 — re-parse the résumé already on file. Either way it's parsed with the user's BYOK Claude to pre-fill their structured Profile + seed the knowledge base (PDF only); the result is reported via a notification.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The apply-agent instance ID (from my_instances)."),
			url: z.string().url().optional().describe("Public URL to the résumé PDF to fetch and upload."),
			content_base64: z.string().optional().describe("The résumé PDF as base64 (alternative to url)."),
			filename: z.string().optional().describe("File name, default resume.pdf."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, url, content_base64, filename, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const name = (filename || "resume.pdf").replace(/[^\w.\- ]/g, "_").slice(0, 120);
			const input = { instance_id, source: content_base64 ? "base64" : url ? "url" : "none", filename: name };
			const denied = await requirePermission(safetyFor(token), "write", "upload_resume", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "upload_resume", "upload a résumé to the apply agent", input, {
					endpoint: `/v1/instances/${instance_id}/apply-resume?name=${encodeURIComponent(name)}`,
					method: "PUT",
				});
			}
			const MAX_RESUME = 8 * 1024 * 1024;
			let bytes: ArrayBuffer;
			if (content_base64) {
				let bin: string;
				try {
					bin = atob(content_base64.replace(/^data:[^,]*,/, ""));
				} catch {
					return text("Error: content_base64 is not valid base64.");
				}
				if (bin.length > MAX_RESUME) return text("Error: résumé too large (max 8MB).");
				const arr = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
				bytes = arr.buffer;
			} else if (url) {
				// Only http(s), and only accept an actual PDF back — a fetched HTML error page
				// must not get stored and labeled application/pdf.
				if (!/^https?:\/\//i.test(url)) return text("Error: url must be an http(s) URL.");
				const r = await fetch(url);
				if (!r.ok) return text(`Error fetching résumé from URL: HTTP ${r.status}`);
				const ct = r.headers.get("content-type") || "";
				if (ct && !/application\/pdf|application\/octet-stream|binary/i.test(ct)) return text(`Error: URL did not return a PDF (content-type: ${ct}).`);
				bytes = await r.arrayBuffer();
				if (bytes.byteLength > MAX_RESUME) return text("Error: résumé too large (max 8MB).");
				// Authoritative check by MAGIC BYTES ("%PDF-"). A missing content-type used to
				// skip validation entirely (the `ct &&` short-circuit), so non-PDF bytes got
				// stored + labeled application/pdf and fed to the parser. Content-type is
				// spoofable/absent; the header is not.
				const head = new Uint8Array(bytes.slice(0, 5));
				if (!(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d)) {
					return text("Error: URL did not return a PDF (missing %PDF header).");
				}
			} else {
				// No source given → re-parse the résumé already on file.
				const res = (await authedCall(`/v1/instances/${instance_id}/apply-resume/parse`, sessionToken, { method: "POST" }, env)) as { error?: string };
				if (!res.error) await audit(safetyFor(token), { tool: "upload_resume", action: "completed", input: { ...input, mode: "reparse" } });
				return jsonText(res);
			}
			const res = (await authedCall(
				`/v1/instances/${instance_id}/apply-resume?name=${encodeURIComponent(name)}`,
				sessionToken,
				{ method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes },
				env,
			)) as { error?: string };
			if (!res.error) await audit(safetyFor(token), { tool: "upload_resume", action: "completed", input });
			return jsonText(res);
		},
	);

	server.tool(
		"apply_to_job",
		"Launch the LLM-driven job application for a private apply-agent instance: the PAGS agent drives the user's local browser to fill (and, only if submit=true, SUBMIT) the application at the given job URL. The résumé comes from the instance's stored résumé and candidate details from the user's Profile. If the agent needs a value it can't truthfully invent (e.g. work authorization), it pauses with a needs_input ticket for the USER to answer in the console, then continues. Default is a safe test run that stops at the Submit button without clicking it.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("The apply-agent instance ID (from my_instances)."),
			url: z.string().describe("The job posting / application URL to apply to."),
			submit: z.boolean().optional().describe("false (default) = fill everything and stop at the Submit button WITHOUT clicking it (safe test). true = actually SUBMIT the application to the employer."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, url, submit, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const realSubmit = submit === true;
			const toolInput = { instance_id, url, submit: realSubmit };
			// A real submission is an outward, hard-to-undo action → destructive scope;
			// a test run (fill-only) is just runtime.
			const denied = await requirePermission(safetyFor(token), realSubmit ? "destructive" : "runtime", "apply_to_job", toolInput);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "apply_to_job", realSubmit ? "SUBMIT a job application to the employer" : "test-fill a job application (stops before submit)", toolInput, {
					endpoint: `/v1/instances/${instance_id}/apply`,
					method: "POST",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/apply`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ url, dryRun: !realSubmit }) },
				env,
			);
			await audit(safetyFor(token), { tool: "apply_to_job", action: "completed", input: toolInput, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"get_profile",
		"Read the authenticated user's structured candidate Profile — name, contact, city/state/country, LinkedIn/website, work authorization, salary expectation, job preferences, and any custom answers the apply agent has saved from needs_input tickets. This is what the job-application agent fills forms from.",
		{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
		async ({ token }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall("/v1/profile", sessionToken, {}, env);
			return jsonText(data);
		},
	);
	} // ── end apply-agent tools ──
	if (groups.has("apply")) {
		server.tool(
			"get_apply_tips",
			"Read the learned per-ATS apply tips for an apply-capable instance (what worked/failed on each ATS host — console Rules & Tips).",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				instance_id: z.string(),
			},
			async ({ token, instance_id }) => {
				const sessionToken = tokenFor(token);
				if (!sessionToken) return authRequired();
				const data = await authedCall(`/v1/instances/${instance_id}/apply-tips`, sessionToken, {}, env);
				return jsonText(data);
			},
		);
	}
}
