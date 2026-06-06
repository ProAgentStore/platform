/**
 * data-analyst — ProAgentStore agent.
 *
 * Upload CSV or JSON data, then ask questions in natural language.
 * Workers AI translates each question into SQL, which runs against the
 * user's D1 tables, and the results are returned as JSON.
 *
 * API
 * ---
 * POST   /upload                  [auth] — upload CSV or JSON; creates a D1 table
 * GET    /tables                         — list all uploaded datasets
 * GET    /tables/:name/schema            — column names + types for one table
 * POST   /query                          — natural language → SQL → results
 * GET    /history                        — recent query history (optional ?dataset=)
 * DELETE /tables/:name             [auth] — drop a dataset + its table
 * GET    /                               — health / version
 */

import { Hono } from "hono";

// ── Types ──────────────────────────────────────────────────────────────────

interface Env {
	AI: Ai;
	DB: D1Database;
	/** Optional: require Bearer token for upload + delete. If unset, open. */
	ADMIN_TOKEN?: string;
}

interface Column {
	name: string;
	type: "TEXT" | "INTEGER" | "REAL";
}

interface Dataset {
	id: string;
	name: string;
	table_name: string;
	source_type: string;
	row_count: number;
	columns: string; // JSON-encoded Column[]
	uploaded_at: string;
}

interface QueryHistoryRow {
	id: string;
	dataset_id: string | null;
	question: string;
	sql: string;
	row_count: number;
	error: string | null;
	executed_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Nanoid-like short ID (URL-safe). */
function uid(len = 12): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let id = "";
	for (const b of bytes) id += chars[b % chars.length];
	return id;
}

/** Sanitise a user-supplied name into a safe SQL table identifier. */
function toTableName(raw: string): string {
	return (
		"t_" +
		raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 48) +
		"_" +
		uid(6)
	);
}

/** Infer a SQLite column type from a sample of string values. */
function inferType(values: string[]): Column["type"] {
	const nonEmpty = values.filter((v) => v !== "" && v !== null);
	if (nonEmpty.length === 0) return "TEXT";
	if (nonEmpty.every((v) => Number.isInteger(Number(v)) && v.trim() !== ""))
		return "INTEGER";
	if (nonEmpty.every((v) => !Number.isNaN(Number(v)) && v.trim() !== ""))
		return "REAL";
	return "TEXT";
}

/**
 * Parse CSV text into an array of row objects.
 * Handles quoted fields (including embedded commas and newlines).
 */
function parseCsv(text: string): Record<string, string>[] {
	// Split into logical lines (respecting quoted newlines)
	const rows: string[][] = [];
	let current: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			current.push(field);
			field = "";
		} else if (ch === "\n" || (ch === "\r" && next === "\n")) {
			if (ch === "\r") i++;
			current.push(field);
			field = "";
			if (current.some((f) => f !== "") || rows.length === 0) {
				rows.push(current);
			}
			current = [];
		} else {
			field += ch;
		}
	}
	// Last field / line
	current.push(field);
	if (current.some((f) => f !== "")) rows.push(current);

	if (rows.length < 2) return [];

	const headers = rows[0].map((h) => h.trim());
	return rows.slice(1).map((cells) => {
		const obj: Record<string, string> = {};
		for (let i = 0; i < headers.length; i++) {
			obj[headers[i]] = (cells[i] ?? "").trim();
		}
		return obj;
	});
}

/**
 * Normalise a JSON upload into an array of flat string-value objects.
 * Accepts: array of objects, or an object whose first array-valued key is used.
 */
function parseJson(text: string): Record<string, string>[] {
	const parsed: unknown = JSON.parse(text);

	let rows: unknown[];
	if (Array.isArray(parsed)) {
		rows = parsed;
	} else if (parsed && typeof parsed === "object") {
		// Find first array property
		const arr = Object.values(parsed as Record<string, unknown>).find(
			Array.isArray,
		) as unknown[] | undefined;
		if (!arr) throw new Error("No array found in JSON object");
		rows = arr;
	} else {
		throw new Error("JSON must be an array or object containing an array");
	}

	return rows.map((row) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) {
			throw new Error("Each JSON row must be an object");
		}
		const flat: Record<string, string> = {};
		for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
			flat[k] =
				v === null || v === undefined
					? ""
					: typeof v === "object"
						? JSON.stringify(v)
						: String(v);
		}
		return flat;
	});
}

/** Derive column definitions from an array of row objects. */
function deriveColumns(rows: Record<string, string>[]): Column[] {
	if (rows.length === 0) return [];
	const keys = Object.keys(rows[0]);
	return keys.map((name) => {
		const sample = rows.slice(0, 200).map((r) => r[name] ?? "");
		return { name: sanitiseColName(name), type: inferType(sample) };
	});
}

/** Sanitise a column name to a safe SQL identifier. */
function sanitiseColName(raw: string): string {
	const clean = raw
		.trim()
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/^([0-9])/, "_$1");
	return clean || "col";
}

/**
 * Insert rows into a D1 table in batches to stay under the 100-statement
 * batch limit and keep individual statement sizes reasonable.
 */
async function batchInsert(
	db: D1Database,
	tableName: string,
	columns: Column[],
	rows: Record<string, string>[],
): Promise<void> {
	const BATCH = 50;
	const colList = columns.map((c) => `"${c.name}"`).join(", ");
	const placeholder = `(${columns.map(() => "?").join(", ")})`;

	for (let i = 0; i < rows.length; i += BATCH) {
		const slice = rows.slice(i, i + BATCH);
		const stmts = slice.map((row) => {
			const values = columns.map((c) => {
				const raw = row[c.name] ?? "";
				if (c.type === "INTEGER") return raw === "" ? null : parseInt(raw, 10);
				if (c.type === "REAL") return raw === "" ? null : parseFloat(raw);
				return raw === "" ? null : raw;
			});
			return db
				.prepare(`INSERT INTO "${tableName}" (${colList}) VALUES ${placeholder}`)
				.bind(...values);
		});
		await db.batch(stmts);
	}
}

// ── AI helpers ─────────────────────────────────────────────────────────────

const SQL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<
	Ai["run"]
>[0];

/**
 * Ask Workers AI to generate a read-only SQL query from a natural language
 * question, given the table schema.
 */
async function generateSql(
	ai: Ai,
	question: string,
	tableName: string,
	columns: Column[],
): Promise<string> {
	const schemaDef = columns
		.map((c) => `  "${c.name}" ${c.type}`)
		.join(",\n");
	const schema = `CREATE TABLE "${tableName}" (\n${schemaDef}\n);`;

	const systemPrompt = `You are a SQLite expert. Given a table schema and a question, produce a single read-only SQL SELECT query that answers the question.

Rules:
- Output ONLY the SQL statement, no explanation, no markdown fences.
- Use only SELECT — no INSERT, UPDATE, DELETE, DROP, CREATE, or any DDL/DML.
- The table name is "${tableName}".
- Wrap all column names in double quotes.
- Limit results to 500 rows maximum using LIMIT unless the question asks for all rows.
- Use appropriate aggregations (COUNT, SUM, AVG, MIN, MAX, GROUP BY) when the question asks for summaries or totals.
- If the question cannot be answered with the given schema, output: SELECT 'Unable to answer this question with the available data' AS message;`;

	const userPrompt = `Schema:\n${schema}\n\nQuestion: ${question}`;

	const result = (await ai.run(SQL_MODEL, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
	})) as { response?: string };

	let sql = (result.response ?? "").trim();

	// Strip markdown fences if the model wrapped them
	sql = sql
		.replace(/^```(?:sql)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	// Reject anything that isn't a SELECT
	if (!/^\s*SELECT\b/i.test(sql)) {
		return `SELECT 'Unable to generate a safe query for this question' AS message;`;
	}

	return sql;
}

// ── App ────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

/** Require ADMIN_TOKEN bearer auth. No-op if token not configured. */
function requireAuth(env: Env, authHeader: string | undefined): boolean {
	if (!env.ADMIN_TOKEN) return true; // open in dev / unconfigured
	return authHeader === `Bearer ${env.ADMIN_TOKEN}`;
}

// Health
app.get("/", (c) =>
	c.json({ agent: "data-analyst", status: "ok", version: "0.0.1" }),
);

// ── POST /upload ───────────────────────────────────────────────────────────

app.post("/upload", async (c) => {
	if (!requireAuth(c.env, c.req.header("Authorization"))) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const contentType = c.req.header("Content-Type") ?? "";

	let rows: Record<string, string>[];
	let sourceType: "csv" | "json";
	let datasetName: string;

	// Accept multipart/form-data (field: file + optional name)
	// or application/json body { name, type, data }
	// or text/csv body with ?name= query param

	if (contentType.includes("multipart/form-data")) {
		const form = await c.req.formData();
		const file = form.get("file");
		if (!file || !(file instanceof File)) {
			return c.json({ error: "form field 'file' is required" }, 400);
		}
		const text = await file.text();
		const nameField = form.get("name");
		datasetName =
			typeof nameField === "string" && nameField
				? nameField
				: file.name.replace(/\.[^.]+$/, "");

		const ext = file.name.split(".").pop()?.toLowerCase();
		if (ext === "json" || file.type.includes("json")) {
			sourceType = "json";
			try {
				rows = parseJson(text);
			} catch (e) {
				return c.json({ error: `JSON parse error: ${(e as Error).message}` }, 400);
			}
		} else {
			sourceType = "csv";
			rows = parseCsv(text);
		}
	} else if (contentType.includes("application/json")) {
		const body = await c.req.json<{
			name?: string;
			type?: string;
			data: string;
		}>();
		if (!body.data) return c.json({ error: "'data' field is required" }, 400);
		datasetName = body.name ?? "dataset";
		if (body.type === "json" || body.type === "application/json") {
			sourceType = "json";
			try {
				rows = parseJson(body.data);
			} catch (e) {
				return c.json({ error: `JSON parse error: ${(e as Error).message}` }, 400);
			}
		} else {
			sourceType = "csv";
			rows = parseCsv(body.data);
		}
	} else {
		// Treat raw body as CSV; ?name= for dataset name
		const text = await c.req.text();
		datasetName = c.req.query("name") ?? "dataset";
		sourceType = "csv";
		rows = parseCsv(text);
	}

	if (rows.length === 0) {
		return c.json({ error: "No data rows found in uploaded file" }, 400);
	}

	const columns = deriveColumns(rows);
	if (columns.length === 0) {
		return c.json({ error: "Could not determine column structure" }, 400);
	}

	const id = uid();
	const tableName = toTableName(datasetName);

	// Create the table
	const colDefs = columns
		.map((c) => `"${c.name}" ${c.type}`)
		.join(", ");
	await c.env.DB.exec(
		`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs});`,
	);

	// Insert rows
	try {
		await batchInsert(c.env.DB, tableName, columns, rows);
	} catch (e) {
		// Clean up on failure
		await c.env.DB.exec(`DROP TABLE IF EXISTS "${tableName}";`);
		return c.json(
			{ error: `Insert failed: ${(e as Error).message}` },
			500,
		);
	}

	// Register dataset
	await c.env.DB.prepare(
		`INSERT INTO datasets (id, name, table_name, source_type, row_count, columns)
         VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, datasetName, tableName, sourceType, rows.length, JSON.stringify(columns))
		.run();

	return c.json(
		{
			id,
			name: datasetName,
			table_name: tableName,
			source_type: sourceType,
			row_count: rows.length,
			columns,
		},
		201,
	);
});

// ── GET /tables ────────────────────────────────────────────────────────────

app.get("/tables", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT id, name, table_name, source_type, row_count, columns, uploaded_at
         FROM datasets ORDER BY uploaded_at DESC`,
	).all<Dataset>();

	const tables = results.map((d) => ({
		...d,
		columns: JSON.parse(d.columns) as Column[],
	}));

	return c.json({ tables, total: tables.length });
});

// ── GET /tables/:name/schema ───────────────────────────────────────────────

app.get("/tables/:name/schema", async (c) => {
	const name = c.req.param("name");

	const dataset = await c.env.DB.prepare(
		`SELECT id, name, table_name, source_type, row_count, columns, uploaded_at
         FROM datasets WHERE table_name = ? OR name = ? LIMIT 1`,
	)
		.bind(name, name)
		.first<Dataset>();

	if (!dataset) return c.json({ error: "Table not found" }, 404);

	return c.json({
		id: dataset.id,
		name: dataset.name,
		table_name: dataset.table_name,
		source_type: dataset.source_type,
		row_count: dataset.row_count,
		uploaded_at: dataset.uploaded_at,
		columns: JSON.parse(dataset.columns) as Column[],
	});
});

// ── POST /query ────────────────────────────────────────────────────────────

app.post("/query", async (c) => {
	const body = await c.req.json<{
		question: string;
		/** table_name or dataset name; optional when there is only one dataset */
		table?: string;
	}>();

	if (!body.question || typeof body.question !== "string") {
		return c.json({ error: "'question' is required" }, 400);
	}

	// Resolve the dataset
	let dataset: Dataset | null = null;
	if (body.table) {
		dataset = await c.env.DB.prepare(
			`SELECT * FROM datasets WHERE table_name = ? OR name = ? LIMIT 1`,
		)
			.bind(body.table, body.table)
			.first<Dataset>();
		if (!dataset) return c.json({ error: `Table '${body.table}' not found` }, 404);
	} else {
		// Default to the most-recently uploaded dataset if exactly one exists
		const { results } = await c.env.DB.prepare(
			`SELECT * FROM datasets ORDER BY uploaded_at DESC LIMIT 2`,
		).all<Dataset>();
		if (results.length === 0) {
			return c.json({ error: "No datasets uploaded yet" }, 400);
		}
		if (results.length > 1) {
			return c.json(
				{
					error: "Multiple datasets exist — specify 'table' in your request",
					tables: results.map((d) => d.table_name),
				},
				400,
			);
		}
		dataset = results[0];
	}

	const columns = JSON.parse(dataset.columns) as Column[];
	const historyId = uid();

	// Generate SQL via Workers AI
	let sql: string;
	try {
		sql = await generateSql(
			c.env.AI,
			body.question,
			dataset.table_name,
			columns,
		);
	} catch (e) {
		return c.json({ error: `AI error: ${(e as Error).message}` }, 502);
	}

	// Execute the generated SQL
	let queryResult: D1Result<Record<string, unknown>>;
	let execError: string | null = null;
	try {
		queryResult = await c.env.DB.prepare(sql).all<Record<string, unknown>>();
	} catch (e) {
		execError = (e as Error).message;
		// Record failure in history
		await c.env.DB.prepare(
			`INSERT INTO query_history (id, dataset_id, question, sql, row_count, error)
             VALUES (?, ?, ?, ?, 0, ?)`,
		)
			.bind(historyId, dataset.id, body.question, sql, execError)
			.run();

		return c.json(
			{ error: "SQL execution failed", detail: execError, sql },
			422,
		);
	}

	const rows = queryResult.results ?? [];

	// Record success in history
	await c.env.DB.prepare(
		`INSERT INTO query_history (id, dataset_id, question, sql, row_count, error)
         VALUES (?, ?, ?, ?, ?, NULL)`,
	)
		.bind(historyId, dataset.id, body.question, sql, rows.length)
		.run();

	return c.json({
		id: historyId,
		question: body.question,
		sql,
		row_count: rows.length,
		results: rows,
	});
});

// ── GET /history ───────────────────────────────────────────────────────────

app.get("/history", async (c) => {
	const datasetFilter = c.req.query("dataset");
	const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);

	let stmt: D1PreparedStatement;
	if (datasetFilter) {
		// Join to resolve by table_name or dataset name
		stmt = c.env.DB.prepare(
			`SELECT qh.* FROM query_history qh
             LEFT JOIN datasets d ON d.id = qh.dataset_id
             WHERE d.table_name = ? OR d.name = ?
             ORDER BY qh.executed_at DESC LIMIT ?`,
		).bind(datasetFilter, datasetFilter, limit);
	} else {
		stmt = c.env.DB.prepare(
			`SELECT * FROM query_history ORDER BY executed_at DESC LIMIT ?`,
		).bind(limit);
	}

	const { results } = await stmt.all<QueryHistoryRow>();
	return c.json({ history: results, total: results.length });
});

// ── DELETE /tables/:name ───────────────────────────────────────────────────

app.delete("/tables/:name", async (c) => {
	if (!requireAuth(c.env, c.req.header("Authorization"))) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const name = c.req.param("name");

	const dataset = await c.env.DB.prepare(
		`SELECT * FROM datasets WHERE table_name = ? OR name = ? LIMIT 1`,
	)
		.bind(name, name)
		.first<Dataset>();

	if (!dataset) return c.json({ error: "Table not found" }, 404);

	// Drop the data table, then remove the registry entry
	await c.env.DB.exec(`DROP TABLE IF EXISTS "${dataset.table_name}";`);
	await c.env.DB.prepare(`DELETE FROM datasets WHERE id = ?`)
		.bind(dataset.id)
		.run();

	return c.json({ deleted: dataset.table_name });
});

// ── Error handling ─────────────────────────────────────────────────────────

app.onError((err, c) => {
	console.error("Unhandled error:", err.message, err.stack);
	return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
