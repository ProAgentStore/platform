import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import type { InstanceToolsCtx } from "./shared.js";

/**
 * Everything an instance KNOWS: knowledge documents, uploaded files, the vector index over
 * both, and memory entries.
 *
 * Three stores, one group, because the user thinks of them as one thing (the console's
 * Knowledge tab) and because they share a rule: adding is `write`, deleting is
 * `destructive` and confirmed by name, and reading is ungated.
 */
export function registerKnowledgeTools(server: McpServer, ctx: InstanceToolsCtx): void {
	const { env, tokenFor, safetyFor } = ctx;

	server.tool(
		"add_instance_knowledge",
		"Add user-specific knowledge to your private subscribed instance. This does not alter the creator's template agent.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			title: z.string(),
			content: z.string(),
			source: z.string().optional(),
			source_url: z.string().optional(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, title, content, source, source_url, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, title, content, source, source_url };
			const denied = await requirePermission(safetyFor(token), "write", "add_instance_knowledge", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "add_instance_knowledge", "add private instance knowledge document", input, {
					endpoint: `/v1/instances/${instance_id}/knowledge`,
					title,
					source: source || "mcp",
					bytes: new TextEncoder().encode(content).length,
				});
			}
			const data = (await authedCall(
				`/v1/instances/${instance_id}/knowledge`,
				sessionToken,
				{
					method: "POST",
					body: JSON.stringify({
						title,
						content,
						source: source || "mcp",
						sourceUrl: source_url,
					}),
				},
				env,
			)) as { id?: string; error?: string };
			if (data.id) await audit(safetyFor(token), { tool: "add_instance_knowledge", action: "completed", input: { instance_id, title, source, source_url }, result: { id: data.id } });
			return text(data.id ? `Added to instance: ${title}` : `Error: ${data.error}`);
		},
	);

	server.tool(
		"list_instance_knowledge",
		"List user-specific knowledge documents in your private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/knowledge`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"search_instance_knowledge",
		"Semantic (vector) search across a private instance's knowledge base — résumé summary, uploaded docs, indexed repo code, etc. Returns the most relevant chunks by similarity. This validates what's actually retrievable from the instance's vector store.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			query: z.string().describe("Natural-language search query."),
			top_k: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
		},
		async ({ token, instance_id, query, top_k }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/search`,
				sessionToken,
				{ method: "POST", body: JSON.stringify({ query, top_k: top_k || 5 }) },
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_knowledge",
		"Delete a knowledge document from your private subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			document_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_knowledge" to delete a knowledge document.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, document_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, document_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_knowledge", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_knowledge", "delete private instance knowledge document", input, {
					endpoint: `/v1/instances/${instance_id}/knowledge/${document_id}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_knowledge", confirm, "delete_instance_knowledge", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/knowledge/${document_id}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_knowledge", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"list_instance_files",
		"List files uploaded to a private subscribed instance (PDFs, documents — the console's Knowledge → Files tab). Shows name, size, mime type, and extraction status (extracted files are vectorized and searchable via search_instance_knowledge).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(
				`/v1/instances/${instance_id}/files`,
				sessionToken,
				{},
				env,
			);
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_file",
		"Delete an uploaded file from a subscribed instance (Knowledge → Files). Removes the R2 object, its metadata, and its vectors.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			file_id: z.string(),
			confirm: z.string().optional().describe('Must be "delete_instance_file" to delete a file.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, file_id, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, file_id };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_file", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_file", "delete instance file", input, {
					endpoint: `/v1/instances/${instance_id}/files/${encodeURIComponent(file_id)}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_file", confirm, "delete_instance_file", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/files/${encodeURIComponent(file_id)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_file", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"vector_stats",
		"What's in a subscribed instance's vector store, grouped by source (files, KB docs, repo files, conversation summaries) with chunk counts — the console's Knowledge → Index panel. Use search_instance_knowledge to test retrieval.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/vectors`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	// ── Instance memory ────────────────────────────────────────────────────────

	server.tool(
		"get_instance_memory",
		"Read a subscribed instance's memory entries (identity, knowledge, preference, skill, context — the console's Knowledge → Memory tab).",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
		},
		async ({ token, instance_id }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/memory`, sessionToken, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"write_instance_memory",
		"Create or update a memory entry on a subscribed instance. Read get_instance_memory first to reuse an existing key instead of creating a near-duplicate.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			key: z.string().describe("Memory key (reuse an existing key to update it)"),
			type: z.enum(["identity", "knowledge", "preference", "skill", "context"]),
			content: z.string(),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, key, type, content, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, key, type };
			const denied = await requirePermission(safetyFor(token), "write", "write_instance_memory", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "write_instance_memory", "write instance memory entry", input, {
					endpoint: `/v1/instances/${instance_id}/memory`,
					method: "PUT",
				});
			}
			const data = await authedCall(
				`/v1/instances/${instance_id}/memory`,
				sessionToken,
				{ method: "PUT", body: JSON.stringify({ key, type, content, source: "user" }) },
				env,
			);
			if (!(data as { error?: string }).error) await audit(safetyFor(token), { tool: "write_instance_memory", action: "completed", input, result: data });
			return jsonText(data);
		},
	);

	server.tool(
		"delete_instance_memory",
		"Delete one memory entry (by key) from a subscribed instance.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			key: z.string().describe("Memory key to delete"),
			confirm: z.string().optional().describe('Must be "delete_instance_memory" to delete a memory entry.'),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, key, confirm, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, key };
			const denied = await requirePermission(safetyFor(token), "destructive", "delete_instance_memory", input);
			if (denied) return denied;
			if (dry_run) {
				return dryRun(safetyFor(token), "delete_instance_memory", "delete instance memory entry", input, {
					endpoint: `/v1/instances/${instance_id}/memory/${encodeURIComponent(key)}`,
					method: "DELETE",
				});
			}
			const unconfirmed = await requireConfirmation(safetyFor(token), "delete_instance_memory", confirm, "delete_instance_memory", input);
			if (unconfirmed) return unconfirmed;
			const data = await authedCall(
				`/v1/instances/${instance_id}/memory/${encodeURIComponent(key)}`,
				sessionToken,
				{ method: "DELETE" },
				env,
			);
			await audit(safetyFor(token), { tool: "delete_instance_memory", action: "completed", input, result: data });
			return jsonText(data);
		},
	);
}
