/**
 * The PDF form tools (#712) — `inspect_pdf_form`, `fill_pdf_form`, `build_answer_sheet`.
 *
 * Split out of `storage-tools.ts` rather than added to it: that file was 799 lines, one under the
 * ratchet's threshold, and these three tools took it to 947. The ratchet's advice ("split it now,
 * which is cheaper than it will ever be again") is right, and this is a clean seam — the PDF
 * tools share the file store with `upload_file`/`read_file` but nothing else, so the only thing
 * they need from their old home is the engine, which is passed in.
 *
 * They are BUILTINS, not registry tools, and that placement is load-bearing rather than
 * incidental. `registryTools()` upholds an invariant that a tool is creator-selectable if and
 * only if a connector provides it — `pipeline-tool-policy` relies on it to decide "is this tool
 * declared by this agent" from the `connector` field alone, avoiding an import cycle through the
 * catalog. A connector-less but creator-selectable REGISTRY tool would have quietly made
 * "declared" mean one thing in chat and another in a pipeline. As builtins they sit exactly where
 * the file tools already do, gated the same way, and the invariant is untouched.
 *
 * The heavy lifting is in `pdf-form.ts`, which is pure. This module is the glue: read bytes from
 * the store, call it, write bytes back.
 */
import type { AgentStorageEngine } from "../agent-storage.js";
import type { ToolCallResult, ToolDef } from "./tools.js";

/** Bytes we will pull into the isolate for one PDF. A form is kilobytes; pdf-lib also holds the
 *  parsed document, so the ceiling is well under the isolate limit on purpose. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** `<name>.pdf` → `<name>-filled.pdf`, leaving any other dots alone. */
export function derivedPdfName(original: string, suffix: string): string {
	const dot = original.lastIndexOf(".");
	if (dot <= 0) return `${original}${suffix}.pdf`;
	return `${original.slice(0, dot)}${suffix}${original.slice(dot)}`;
}

/** Read one stored file's raw bytes, bounded. `fileGet` streams from R2, so this drains it. */
async function readPdfBytes(
	engine: Pick<AgentStorageEngine, "fileGet">,
	fileId: string,
): Promise<{ data: Uint8Array; name: string } | { error: string }> {
	const file = await engine.fileGet(fileId);
	if (!file) return { error: `No file ${fileId} in your files. Use list_files to see what is there.` };
	const buf = await new Response(file.body).arrayBuffer();
	if (buf.byteLength > MAX_PDF_BYTES) {
		return { error: `That PDF is ${Math.round(buf.byteLength / 1024 / 1024)}MB, over the ${MAX_PDF_BYTES / 1024 / 1024}MB limit.` };
	}
	return { data: new Uint8Array(buf), name: file.meta.name };
}
function ok(name: string, content: string): ToolCallResult {
	return { name, content, success: true };
}

function fail(name: string, content: string): ToolCallResult {
	return { name, content, success: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringInput(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The three tool declarations, spread into STORAGE_TOOLS by storage-tools.ts. */
export const PDF_STORAGE_TOOLS: ToolDef[] = [
	{
		name: "inspect_pdf_form",
		description:
			"List the fillable fields of a PDF in your files — exact names, types, and for dropdowns and radio groups the permitted values. Call this BEFORE fill_pdf_form; never guess a field name. If it reports has_form false the PDF is flat or a scan and cannot be filled in place — read its text and use build_answer_sheet instead.",
		parameters: {
			file_id: { type: "string", description: "File id of the PDF (from list_files).", required: true },
		},
	},
	{
		name: "fill_pdf_form",
		description:
			"Fill the form fields of a PDF in your files and save the result as a NEW file, returning its id. Use the exact field names from inspect_pdf_form — a name the form does not have is reported back unfilled, never silently dropped. Flattened by default so the values cannot be edited away. Fails if the PDF has no form fields.",
		parameters: {
			file_id: { type: "string", description: "File id of the PDF to fill.", required: true },
			values: { type: "object", description: 'Field name to value, e.g. {"player_name":"Sam Tan","is_member":true}. Names must match inspect_pdf_form exactly.', required: true },
			flatten: { type: "boolean", description: "Bake the values in so they cannot be edited. Default true." },
		},
	},
	{
		name: "build_answer_sheet",
		description:
			"Generate a clean PDF of questions and their answers, saved to your files. This is the answer when a form is a flat scan with no fillable fields: send it alongside the original rather than attaching an empty form.",
		parameters: {
			title: { type: "string", description: "Document title, e.g. 'Summer Competition Entry'.", required: true },
			entries: { type: "array", description: 'The questions and answers as [{"label":"Player name","value":"Sam Tan"}, ...], in reading order.', required: true },
		},
	}
];

export const PDF_TOOL_NAMES: ReadonlySet<string> = new Set(PDF_STORAGE_TOOLS.map((t) => t.name));

/**
 * Run one PDF tool. Returns `null` when the call is not one of ours, so the caller's switch can
 * fall through — the delegation stays a one-line branch instead of a name list kept in two places.
 */
export async function executePdfTool(
	call: { name: string; input: Record<string, unknown> },
	engine: Pick<AgentStorageEngine, "fileGet" | "fileUpload">,
	ctx?: { userId?: string },
): Promise<ToolCallResult | null> {
	switch (call.name) {
	case "inspect_pdf_form":
	case "fill_pdf_form": {
		const fileId = stringInput(call.input.file_id);
		if (!fileId) return fail(call.name, "file_id required");
		const bytes = await readPdfBytes(engine, fileId);
		if ("error" in bytes) return fail(call.name, bytes.error);

		const { inspectPdfForm, fillPdfForm, PdfFormError } = await import("./pdf-form.js");
		try {
			if (call.name === "inspect_pdf_form") {
				const info = await inspectPdfForm(bytes.data);
				if (!info.hasForm) {
					return ok(call.name, JSON.stringify({
						name: bytes.name,
						pages: info.pageCount,
						has_form: false,
						fields: [],
						note: "This PDF has no fillable fields — it is flat or a scan, and cannot be filled in place. Read its text to find the questions, then use build_answer_sheet to produce an answer document to send alongside it.",
					}, null, 2));
				}
				return ok(call.name, JSON.stringify({ name: bytes.name, pages: info.pageCount, has_form: true, fields: info.fields }, null, 2));
			}

			const values = call.input.values;
			if (!isPlainRecord(values)) {
				return fail(call.name, 'values required — an object of field name to value, e.g. {"player_name":"Sam Tan"}. Call inspect_pdf_form first for the exact names.');
			}
			const filledDoc = await fillPdfForm(bytes.data, values as Record<string, string | boolean>, {
				flatten: call.input.flatten !== false,
			});
			const outName = derivedPdfName(bytes.name, "-filled");
			const meta = await engine.fileUpload({
				name: outName,
				mimeType: "application/pdf",
				data: filledDoc.bytes.slice().buffer as ArrayBuffer,
				userId: ctx?.userId,
				tags: ["generated"],
				// An artefact to send, not a document to answer questions from. Indexing it
				// would put the same facts in the vector store twice, phrased worse.
				extractText: false,
			});
			return ok(call.name, JSON.stringify({
				file_id: meta.id,
				name: outName,
				size: meta.size,
				filled: filledDoc.filled,
				unknown_fields: filledDoc.unknown,
				left_blank: filledDoc.untouched,
				...(filledDoc.unknown.length
					? { warning: `These names are not on the form and were NOT filled: ${filledDoc.unknown.join(", ")}. Call inspect_pdf_form for the exact field names.` }
					: {}),
			}, null, 2));
		} catch (e) {
			if (e instanceof PdfFormError) return fail(call.name, e.message);
			return fail(call.name, `Could not process that PDF: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	case "build_answer_sheet": {
		const title = stringInput(call.input.title);
		const raw = Array.isArray(call.input.entries) ? call.input.entries : null;
		if (!title) return fail(call.name, "title required — e.g. 'Summer Competition Entry'");
		if (!raw?.length) return fail(call.name, 'entries required — [{"label":"Player name","value":"Sam Tan"}, ...]');
		const entries = raw
			.map((e) => {
				const row = (e ?? {}) as { label?: unknown; value?: unknown };
				return { label: String(row.label ?? "").trim(), value: String(row.value ?? "").trim() };
			})
			.filter((e) => e.label);
		if (entries.length === 0) return fail(call.name, "every entry needs a label");

		const { buildAnswerDocument } = await import("./pdf-form.js");
		try {
			const bytes = await buildAnswerDocument(title, entries);
			const name = `${title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "answers"}.pdf`;
			const meta = await engine.fileUpload({
				name,
				mimeType: "application/pdf",
				data: bytes.slice().buffer as ArrayBuffer,
				userId: ctx?.userId,
				tags: ["generated"],
				extractText: false,
			});
			return ok(call.name, JSON.stringify({ file_id: meta.id, name, size: meta.size, entries: entries.length }, null, 2));
		} catch (e) {
			return fail(call.name, `Could not build the answer sheet: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
		default:
			return null;
	}
}
