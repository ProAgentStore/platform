import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * A precise console link to hand a person (#938) — one tool, its own module, like `guide.ts`.
 *
 * The URL is built by the API from the same builders the console's route table is tested against
 * (`lib/console-deep-link.ts`), so this tool never restates the console's URL scheme. Ungated: every
 * instance has a console page.
 */
export function registerConsoleLinkTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"get_console_link",
		"A console URL that opens exactly what you are discussing with the owner: an instance, one of its runs, a task, a pending secret request, a permission request, one tab, or target files-upload for the eligible Knowledge → Files uploader. Use it instead of writing a console URL by hand: a guessed link still opens a page, just not the one you named. Returns url (absolute, for a chat message), path (the same page as a console path, for a push notification) and lands (what the person will see). Give at most ONE of section, target, run_id, task_id, secure_input_id or permission_request_id; with none it opens the instance. A section or Files upload unavailable to this instance is refused with a reason. Uploaded Files are stored in R2/AgentDO and indexed for instance knowledge; they are NOT automatically consumed by Application Tailor's local_artifact runner, which reads its configured local workspace sources. Selecting an uploaded file as a Tailor source needs a separate materialization step. There is no anchor finer than a tab or a record page beyond target files-upload — for a field, name the tab that holds it, e.g. settings for a setting, knowledge for a memory entry, behaviour for a behaviour field.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances. Copy it exactly."),
			section: z
				.string()
				.optional()
				.describe("A console tab: chat, apply, board, repo, coding, tmux, activity, stats, knowledge, behaviour, feedback, indexing, data or settings."),
			target: z.literal("files-upload").optional().describe("The eligible Knowledge → Files uploader. Its link never contains an upload token or credential."),
			run_id: z.string().optional().describe("A loop run id, as coding_loop_start or coding_loop_status returned it. A coding run opens its session; a chat run opens the Assistant."),
			task_id: z.string().optional().describe("A runtime task id from instance_board or get_instance_task — opens the task's own page."),
			secure_input_id: z.string().optional().describe("A request id from secure_input_request — opens the page where the owner enters the value."),
			permission_request_id: z.string().optional().describe("An owner-scoped permission request id from a blocked tool result — opens the exact Permissions & Connections control. It never grants or resumes anything."),
		},
		async ({ token, instance_id, section, target, run_id, task_id, secure_input_id, permission_request_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const denied = await requirePermission(safetyFor(token), "read", "get_console_link", { instance_id, section, target, run_id, task_id, secure_input_id, permission_request_id });
			if (denied) return denied;
			const q = new URLSearchParams();
			for (const [k, v] of Object.entries({ section, target, run_id, task_id, secure_input_id, permission_request_id })) if (v) q.set(k, v);
			const qs = q.toString() ? `?${q}` : "";
			const data = (await authedCall(`/v1/instances/${encodeURIComponent(instance_id)}/console-link${qs}`, sessionToken, {}, env)) as { error?: string };
			if (data.error) return text(`Error: ${data.error}`);
			return jsonText(data);
		},
	);
}
