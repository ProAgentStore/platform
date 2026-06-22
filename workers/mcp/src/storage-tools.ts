/**
 * MCP storage tools — collections, files, vector search for agent instances.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authedCall, authRequired, type McpEnv, jsonText, text } from "./http.js";
import {
	audit,
	requirePermission,
	type SafetyContext,
} from "./safety.js";

type TokenResolver = (provided?: string) => string | null;
type SafetyResolver = (provided?: string) => SafetyContext;

export function registerStorageTools(
	server: McpServer,
	env: McpEnv,
	tokenFor: TokenResolver,
	safetyFor: SafetyResolver,
): void {
	// ── Collections ──────────────────────────────────────────────────────────

	server.tool(
		"list_collections",
		"List all data collections (tables) for an agent. Shows schema and record counts.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
		},
		async ({ token, agent_id }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const data = await authedCall(`/v1/agents/${agent_id}/collections`, t, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"create_collection",
		"Create a new data collection for an agent. Define fields with types and indexing.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			name: z.string().describe("Collection name (lowercase, a-z0-9_)"),
			fields: z.string().describe('JSON array of field defs: [{"name":"email","type":"string","required":true,"indexed":true,"unique":true}]'),
		},
		async ({ token, agent_id, name, fields }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "create_collection", { agent_id, name });
			if (denied) return denied;
			let parsedFields: unknown;
			try { parsedFields = JSON.parse(fields); } catch { return text("Invalid fields JSON"); }
			const data = await authedCall(`/v1/agents/${agent_id}/collections`, t, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, fields: parsedFields }),
			}, env);
			audit(safetyFor(token), { tool: "create_collection", action: "write", input: { agent_id, name } });
			return jsonText(data);
		},
	);

	server.tool(
		"query_records",
		"Query records from a collection. Filter by field values, sort, paginate.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			collection: z.string().describe("Collection name"),
			where: z.string().optional().describe('JSON filter: {"status":"submitted"}'),
			order_by: z.string().optional(),
			limit: z.number().optional(),
		},
		async ({ token, agent_id, collection, where, order_by, limit }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const params = new URLSearchParams();
			if (where) params.set("where", where);
			if (order_by) params.set("order_by", order_by);
			if (limit) params.set("limit", String(limit));
			const q = params.toString() ? `?${params}` : "";
			const data = await authedCall(`/v1/agents/${agent_id}/collections/${collection}/records${q}`, t, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"insert_record",
		"Insert a new record into a collection.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			collection: z.string().describe("Collection name"),
			data: z.string().describe("JSON object with field values"),
		},
		async ({ token, agent_id, collection, data: dataStr }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "insert_record", { agent_id, collection });
			if (denied) return denied;
			let parsed: unknown;
			try { parsed = JSON.parse(dataStr); } catch { return text("Invalid data JSON"); }
			const result = await authedCall(`/v1/agents/${agent_id}/collections/${collection}/records`, t, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: parsed }),
			}, env);
			audit(safetyFor(token), { tool: "insert_record", action: "write", input: { agent_id, collection } });
			return jsonText(result);
		},
	);

	server.tool(
		"update_record",
		"Update fields on an existing record.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			collection: z.string().describe("Collection name"),
			record_id: z.string().describe("Record ID"),
			data: z.string().describe("JSON object with fields to update"),
		},
		async ({ token, agent_id, collection, record_id, data: dataStr }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "update_record", { agent_id, collection, record_id });
			if (denied) return denied;
			let parsed: unknown;
			try { parsed = JSON.parse(dataStr); } catch { return text("Invalid data JSON"); }
			const result = await authedCall(`/v1/agents/${agent_id}/collections/${collection}/records/${record_id}`, t, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: parsed }),
			}, env);
			audit(safetyFor(token), { tool: "update_record", action: "write", input: { agent_id, collection, record_id } });
			return jsonText(result);
		},
	);

	// ── Files ────────────────────────────────────────────────────────────────

	server.tool(
		"list_agent_files",
		"List files stored by an agent (resumes, documents, etc.).",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			tags: z.string().optional().describe("Comma-separated tags to filter"),
		},
		async ({ token, agent_id, tags }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const params = new URLSearchParams();
			if (tags) params.set("tags", tags);
			const q = params.toString() ? `?${params}` : "";
			const data = await authedCall(`/v1/agents/${agent_id}/files${q}`, t, {}, env);
			return jsonText(data);
		},
	);

	server.tool(
		"upload_agent_file",
		"Upload a text file to an agent's storage.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			name: z.string().describe("Filename with extension"),
			content: z.string().describe("File content (text)"),
			mime_type: z.string().optional(),
			tags: z.string().optional().describe("Comma-separated tags"),
		},
		async ({ token, agent_id, name, content, mime_type, tags }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const denied = await requirePermission(safetyFor(token), "write", "upload_agent_file", { agent_id, name });
			if (denied) return denied;
			const result = await authedCall(`/v1/agents/${agent_id}/files`, t, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					content,
					mime_type: mime_type || "text/plain",
					tags: tags?.split(",").map((s) => s.trim()).filter(Boolean),
				}),
			}, env);
			audit(safetyFor(token), { tool: "upload_agent_file", action: "write", input: { agent_id, name } });
			return jsonText(result);
		},
	);

	// ── Search ───────────────────────────────────────────────────────────────

	server.tool(
		"search_agent_knowledge",
		"Semantic search across an agent's knowledge base, conversation history, and files.",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			query: z.string().describe("Natural language search query"),
			top_k: z.number().optional().describe("Number of results (default 5)"),
		},
		async ({ token, agent_id, query, top_k }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const data = await authedCall(`/v1/agents/${agent_id}/search`, t, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query, top_k: top_k || 5 }),
			}, env);
			return jsonText(data);
		},
	);

	// ── Activity ─────────────────────────────────────────────────────────────

	server.tool(
		"agent_activity",
		"Get recent activity log for an agent (chat, tool calls, file uploads, etc.).",
		{
			token: z.string().optional(),
			agent_id: z.string().describe("Agent ID or slug"),
			limit: z.number().optional().describe("Number of events (default 20)"),
		},
		async ({ token, agent_id, limit }) => {
			const t = tokenFor(token);
			if (!t) return authRequired();
			const params = new URLSearchParams();
			if (limit) params.set("limit", String(limit));
			const q = params.toString() ? `?${params}` : "";
			const data = await authedCall(`/v1/agents/${agent_id}/activity${q}`, t, {}, env);
			return jsonText(data);
		},
	);
}
