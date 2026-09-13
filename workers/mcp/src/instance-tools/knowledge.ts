import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authRequired, authedCall, jsonText, text } from "../http.js";
import { audit, dryRun, requireConfirmation, requirePermission } from "../safety.js";
import { fitPage } from "../wire-budget.js";
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
			top_k: z.coerce.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
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

	// ── Knowledge writes the console had and MCP did not (#613) ──────────────────
	//
	// `add_instance_knowledge` only APPENDS, so a correction over MCP was delete-then-add: a new id,
	// a confirm-gated destructive call, and a window with the document gone. Editing in place keeps
	// the id and re-indexes; ingesting a URL uses the DO's own SSRF-guarded fetch rather than asking
	// the caller to fetch and paste.

	server.tool(
		"update_instance_knowledge",
		"Edit one knowledge document on your private subscribed instance IN PLACE — same `document_id`, no delete-and-re-add. Pass `title`, `content`, or both; whatever you omit is left as it is. `content` REPLACES the document body (max 100KB), it is not appended. The document is re-indexed for search, and the result carries `vectorized: false` if that did not happen (indexing off, or it failed) — the edit is still saved. Get `document_id` from list_instance_knowledge.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			document_id: z.string().describe("Knowledge document `id` from list_instance_knowledge — copy it exactly."),
			title: z.string().optional().describe("New title. Omit to keep the current one."),
			content: z.string().optional().describe("New full body — replaces the old one. Omit to keep the current body."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, document_id, title, content, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			// Only the fields supplied: the route keeps an absent field, so a manufactured one would be
			// an edit the caller never asked for.
			const body: { title?: string; content?: string } = {};
			if (title !== undefined) body.title = title;
			if (content !== undefined) body.content = content;
			const input = { instance_id, document_id, fields: Object.keys(body) };
			const denied = await requirePermission(safetyFor(token), "write", "update_instance_knowledge", input);
			if (denied) return denied;
			if (!Object.keys(body).length) return text("Error: pass title, content, or both — nothing to update.");
			const endpoint = `/v1/instances/${instance_id}/knowledge/${encodeURIComponent(document_id)}`;
			if (dry_run) {
				return dryRun(safetyFor(token), "update_instance_knowledge", "edit a private instance knowledge document in place", input, {
					endpoint,
					method: "PUT",
					fields: Object.keys(body),
					...(content !== undefined ? { bytes: new TextEncoder().encode(content).length } : {}),
				});
			}
			const data = (await authedCall(endpoint, sessionToken, { method: "PUT", body: JSON.stringify(body) }, env)) as { id?: string; error?: string; vectorized?: boolean };
			if (!data.error) {
				await audit(safetyFor(token), { tool: "update_instance_knowledge", action: "completed", input, result: { id: data.id, vectorized: data.vectorized } });
			}
			return jsonText(data);
		},
	);

	server.tool(
		"ingest_instance_knowledge_url",
		"Fetch a public web page into your private subscribed instance's knowledge base as a new document — the platform does the fetch, so do not fetch and paste it yourself. https only, and non-public hosts are refused (checked on every redirect). HTML is reduced to text and the document is capped at 50KB. Counts toward the instance's 20-document limit and is refused when that is full. Returns the new document, including its `id`; `title` defaults to the host name.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string().describe("Instance ID from my_instances"),
			url: z.string().describe("https:// URL of a public page."),
			title: z.string().optional().describe("Document title. Defaults to the URL's host name."),
			dry_run: z.boolean().optional(),
		},
		async ({ token, instance_id, url, title, dry_run }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const input = { instance_id, url, title };
			const denied = await requirePermission(safetyFor(token), "write", "ingest_instance_knowledge_url", input);
			if (denied) return denied;
			const endpoint = `/v1/instances/${instance_id}/knowledge/ingest-url`;
			if (dry_run) {
				// The preview does NOT fetch the page: a dry run touches no network, and "is this URL
				// reachable and public" is decided by the fetch itself, on the server.
				return dryRun(safetyFor(token), "ingest_instance_knowledge_url", "fetch a URL into private instance knowledge", input, {
					endpoint,
					method: "POST",
					url,
					title: title ?? "(the URL's host name)",
				});
			}
			const data = (await authedCall(endpoint, sessionToken, { method: "POST", body: JSON.stringify(title !== undefined ? { url, title } : { url }) }, env)) as {
				id?: string;
				error?: string;
			};
			if (!data.error) {
				await audit(safetyFor(token), { tool: "ingest_instance_knowledge_url", action: "completed", input, result: { id: data.id } });
			}
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
		"What's in a subscribed instance's vector store, grouped by source (files, KB docs, repo files, conversation summaries) with chunk counts — the console's Knowledge → Index panel. Use search_instance_knowledge to test retrieval. The three totals (`totalSources`, `totalChunks`, `totalChars`) always describe the WHOLE store and are never reduced, so \"how much is indexed\" is answerable from any page. `sources` is a PAGE of that store: read `page.hasMore` and call again with `offset: page.nextOffset` to continue. A repo-backed instance runs to thousands of sources — one measured at 315 sources and 151,700 bytes, 2.3x a calling host's 64 KiB limit — so a single reply cannot carry them all and never could.",
		{
			token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
			instance_id: z.string(),
			offset: z.coerce.number().int().min(0).optional().describe("Skip this many sources. Pass `page.nextOffset` from the previous reply; omit for the first page."),
			limit: z.coerce.number().int().min(1).optional().describe("Cap the sources returned. The reply is budgeted to fit a host's wire limit regardless, so a large limit is silently reduced rather than refused — `page.count` says what you got."),
		},
		async ({ token, instance_id, offset, limit }) => {
			const sessionToken = tokenFor(token);
			if (!sessionToken) return authRequired();
			const data = await authedCall(`/v1/instances/${instance_id}/vectors`, sessionToken, {}, env);
			// An `{error}` body carries no `sources` and passes through untouched rather than being
			// reshaped into a success with an empty inventory — the same rule `list_instance_tools`
			// follows next door, and for the same reason: an empty store and an unreadable one are
			// different answers.
			const rec = data as { sources?: unknown[]; error?: string };
			if (!Array.isArray(rec.sources)) return jsonText(data);
			const { sources, ...totals } = rec;
			// The totals ride in FRONT of the page and describe the whole store, so a caller that
			// reads one page still knows the size of what it did not read (#503's rule: the count
			// must never live in the part that gets cut).
			const fitted = fitPage({
				rows: sources,
				offset,
				limit,
				build: (rows, page) => ({ ...totals, page, sources: rows }),
			});
			return text(fitted.text);
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
