import { describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { executeStorageTool } from "./storage-tools.js";
import { derivedPdfName } from "./pdf-storage-tools.js";
import type { AgentStorageEngine } from "../agent-storage.js";

/**
 * The tool layer over `pdf-form.ts` (#712), exercised through `executeStorageTool` — the same
 * entry point the chat runtime uses, so a wiring mistake between the switch and the handler shows
 * up here rather than in production.
 *
 * The engine is a stub with just the two methods these tools touch. Real PDFs, though: a fixture
 * built by pdf-lib, because "does it fill a form" is not answerable against a fake.
 */

async function makeForm(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([595, 842]);
	await doc.embedFont(StandardFonts.Helvetica);
	doc.getForm().createTextField("player_name").addToPage(page, { x: 50, y: 700, width: 200, height: 18 });
	return doc.save();
}

async function makeFlat(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([595, 842]);
	return doc.save();
}

function engineWith(source?: Uint8Array, name = "SummerComp.pdf") {
	const uploads: Array<Record<string, unknown>> = [];
	const engine = {
		fileGet: vi.fn(async (id: string) =>
			source && id === "f1" ? { meta: { name }, body: new Response(source).body } : null,
		),
		fileUpload: vi.fn(async (opts: Record<string, unknown>) => {
			uploads.push(opts);
			return { id: "f2", size: 4242 };
		}),
	} as unknown as AgentStorageEngine;
	return { engine, uploads };
}

const call = (name: string, input: Record<string, unknown>) => ({ name, input });

describe("derivedPdfName", () => {
	it("inserts the suffix before the extension", () => {
		expect(derivedPdfName("SummerComp.pdf", "-filled")).toBe("SummerComp-filled.pdf");
		expect(derivedPdfName("my.form.v2.pdf", "-filled")).toBe("my.form.v2-filled.pdf");
		expect(derivedPdfName("noextension", "-filled")).toBe("noextension-filled.pdf");
	});
});

describe("inspect_pdf_form", () => {
	it("lists the fields of a real form", async () => {
		const { engine } = engineWith(await makeForm());
		const res = await executeStorageTool(call("inspect_pdf_form", { file_id: "f1" }), engine);
		expect(res.content).toContain("player_name");
		expect(res.content).toContain('"has_form": true');
	});

	it("names the way out when the PDF is flat, instead of leaving a dead end", async () => {
		const { engine } = engineWith(await makeFlat());
		const res = await executeStorageTool(call("inspect_pdf_form", { file_id: "f1" }), engine);
		// A model told only "no" starts guessing; told "use build_answer_sheet" it does that.
		expect(res.content).toContain("build_answer_sheet");
		expect(res.content).toContain('"has_form": false');
	});

	it("refuses a file id that is not there, and says how to find one", async () => {
		const { engine } = engineWith(undefined);
		const res = await executeStorageTool(call("inspect_pdf_form", { file_id: "nope" }), engine);
		expect(res.content).toContain("list_files");
	});
});

describe("fill_pdf_form", () => {
	it("writes a NEW file and leaves the source alone", async () => {
		const { engine, uploads } = engineWith(await makeForm());
		const res = await executeStorageTool(call("fill_pdf_form", { file_id: "f1", values: { player_name: "Sam Tan" } }), engine);
		expect(res.content).toContain("f2");
		expect(uploads).toHaveLength(1);
		expect(uploads[0]).toMatchObject({ name: "SummerComp-filled.pdf", mimeType: "application/pdf" });
		// An artefact to send, not a document to answer questions from: indexing it would put the
		// same facts in the vector store twice, phrased worse.
		expect(uploads[0].extractText).toBe(false);
	});

	it("actually put the value in the document, not just in the response", async () => {
		const { engine, uploads } = engineWith(await makeForm());
		await executeStorageTool(call("fill_pdf_form", { file_id: "f1", values: { player_name: "Sam Tan" }, flatten: false }), engine);
		const written = await PDFDocument.load(uploads[0].data as ArrayBuffer);
		expect(written.getForm().getTextField("player_name").getText()).toBe("Sam Tan");
	});

	it("warns loudly about a field name the form does not have", async () => {
		const { engine } = engineWith(await makeForm());
		const res = await executeStorageTool(call("fill_pdf_form", { file_id: "f1", values: { playerName: "Sam Tan" } }), engine);
		expect(res.content).toContain("playerName");
		expect(res.content).toContain("warning");
	});

	it("fails, and stores NOTHING, when the PDF has no form", async () => {
		const { engine, uploads } = engineWith(await makeFlat());
		const res = await executeStorageTool(call("fill_pdf_form", { file_id: "f1", values: { player_name: "x" } }), engine);
		expect(res.content).toMatch(/no fillable form fields/);
		// Storing an unchanged "filled" form is the silent-empty-form failure this guards.
		expect(uploads).toHaveLength(0);
	});

	it("insists on a values object rather than guessing", async () => {
		const { engine } = engineWith(await makeForm());
		for (const input of [{ file_id: "f1" }, { file_id: "f1", values: ["a"] }, { file_id: "f1", values: "x" }]) {
			const res = await executeStorageTool(call("fill_pdf_form", input), engine);
			expect(res.content).toContain("values required");
		}
	});
});

describe("build_answer_sheet", () => {
	it("generates a PDF and names it from the title", async () => {
		const { engine, uploads } = engineWith();
		const res = await executeStorageTool(
			call("build_answer_sheet", { title: "Summer Competition Entry", entries: [{ label: "Player name", value: "Sam Tan" }] }),
			engine,
		);
		expect(res.content).toContain("f2");
		expect(uploads[0]).toMatchObject({ name: "Summer-Competition-Entry.pdf", mimeType: "application/pdf" });
		expect((await PDFDocument.load(uploads[0].data as ArrayBuffer)).getPageCount()).toBe(1);
	});

	it("requires a title and at least one labelled entry", async () => {
		const { engine, uploads } = engineWith();
		for (const input of [
			{ entries: [{ label: "a", value: "b" }] },
			{ title: "T", entries: [] },
			{ title: "T", entries: [{ value: "b" }] },
		]) {
			const res = await executeStorageTool(call("build_answer_sheet", input), engine);
			expect(res.content).toBeTruthy();
		}
		expect(uploads).toHaveLength(0);
	});
});
