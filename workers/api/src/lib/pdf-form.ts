/**
 * Filling a PDF form (#712).
 *
 * PAGS could read a PDF — `resume-parse.ts` hands one to Claude as a `document` block, and
 * `agent-storage-utils.ts` extracts its text with unpdf — but nothing could WRITE one. So the
 * last step of "read the mail, fill the form attached to it, reply with it" had no
 * implementation at all.
 *
 * ── Two paths, because real forms are not all the same ──────────────────────
 *
 * A PDF with an AcroForm has named fields and can be filled exactly. A flat one — a scan, or an
 * export that printed its fields away — has nothing to fill, and the honest failure mode matters
 * more here than the happy path: `pdf-lib` will load a flat PDF, report zero fields, fill
 * nothing, and hand back a byte-identical document. An agent that then attaches it has sent an
 * EMPTY form while reporting success, which is worse than refusing, because the human believes
 * the task is done.
 *
 * So `fillPdfForm` refuses a formless PDF rather than returning it unchanged, and
 * `buildAnswerDocument` exists as the deliberate second path: a clean, generated PDF listing
 * each question and its answer, to attach ALONGSIDE the original. Less pretty than a filled
 * form, and it is a real answer rather than a silent non-answer.
 *
 * Everything here is pure: bytes in, bytes out, no I/O and no env. The tool layer
 * (`pdf-tools.ts`) does the file-store round trip.
 */
import { PDFDocument, StandardFonts, rgb, type PDFForm, type PDFFont } from "pdf-lib";

/** What one fillable field is, in the vocabulary a model can act on. */
export interface PdfFormField {
	name: string;
	type: "text" | "checkbox" | "dropdown" | "radio" | "optionlist" | "button" | "unknown";
	/** The permitted values, for the field types that have a closed set. */
	options?: string[];
}

export interface PdfFormInspection {
	hasForm: boolean;
	fields: PdfFormField[];
	pageCount: number;
}

function classify(fieldCtorName: string): PdfFormField["type"] {
	switch (fieldCtorName) {
		case "PDFTextField": return "text";
		case "PDFCheckBox": return "checkbox";
		case "PDFDropdown": return "dropdown";
		case "PDFRadioGroup": return "radio";
		case "PDFOptionList": return "optionlist";
		case "PDFButton": return "button";
		default: return "unknown";
	}
}

function describeFields(form: PDFForm): PdfFormField[] {
	return form.getFields().map((f) => {
		const type = classify(f.constructor.name);
		const withOptions = f as unknown as { getOptions?: () => string[] };
		const options = typeof withOptions.getOptions === "function" ? withOptions.getOptions() : undefined;
		return { name: f.getName(), type, ...(options?.length ? { options } : {}) };
	});
}

/** List a PDF's fillable fields. The model must not guess field names — this is how it learns them. */
export async function inspectPdfForm(bytes: Uint8Array): Promise<PdfFormInspection> {
	const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
	const fields = describeFields(doc.getForm());
	return { hasForm: fields.length > 0, fields, pageCount: doc.getPageCount() };
}

export class PdfFormError extends Error {}

export interface FillResult {
	bytes: Uint8Array;
	/** Fields that received a value. */
	filled: string[];
	/** Names supplied that the form does not have — reported, never swallowed. */
	unknown: string[];
	/** Fields the form has that were left untouched. */
	untouched: string[];
}

/**
 * Fill an AcroForm and (by default) flatten it.
 *
 * Flattening bakes the values into the page content, so what the recipient opens cannot be
 * accidentally edited and renders identically in viewers that ignore form data — which is most
 * of the ones a tennis club will open it in. Pass `flatten: false` to keep it editable.
 *
 * An unknown field name is a REPORTED outcome, not an error and not a silence: the model
 * guessing "playerName" when the form says "player_name" is the likeliest mistake here, and it
 * has to see that its value went nowhere.
 */
export async function fillPdfForm(
	bytes: Uint8Array,
	values: Record<string, string | boolean>,
	opts: { flatten?: boolean } = {},
): Promise<FillResult> {
	const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
	const form = doc.getForm();
	const present = new Map(form.getFields().map((f) => [f.getName(), f] as const));
	if (present.size === 0) {
		throw new PdfFormError(
			"This PDF has no fillable form fields — it is a flat document or a scan. Nothing can be typed into it directly. " +
				"Build an answer sheet instead and attach it alongside the original.",
		);
	}

	const filled: string[] = [];
	const unknown: string[] = [];
	for (const [name, raw] of Object.entries(values)) {
		const field = present.get(name);
		if (!field) {
			unknown.push(name);
			continue;
		}
		const type = classify(field.constructor.name);
		const text = typeof raw === "boolean" ? (raw ? "Yes" : "No") : String(raw);
		try {
			if (type === "checkbox") {
				const box = field as unknown as { check: () => void; uncheck: () => void };
				const on = typeof raw === "boolean" ? raw : /^(y|yes|true|on|x|1|checked)$/i.test(text.trim());
				if (on) box.check();
				else box.uncheck();
			} else if (type === "dropdown" || type === "optionlist" || type === "radio") {
				// pdf-lib does NOT reject a value outside the option set — a dropdown quietly GAINS
				// "Wednesday" as a new option and reports success, so a form goes back with a
				// selection the club's own document never offered. Measured, not assumed: the test
				// for this originally expected a throw and got a resolved promise.
				//
				// Matched case-insensitively and trimmed, then set to the option's OWN spelling, so
				// "sunday" selects "Sunday" instead of failing on a capital letter.
				const allowed = (field as unknown as { getOptions?: () => string[] }).getOptions?.() ?? [];
				const match = allowed.find((o) => o.trim().toLowerCase() === text.trim().toLowerCase());
				if (allowed.length > 0 && !match) {
					throw new PdfFormError(
						`Could not set "${name}" to "${text}" — allowed values are: ${allowed.join(", ")}.`,
					);
				}
				(field as unknown as { select: (v: string) => void }).select(match ?? text);
			} else if (type === "text") {
				(field as unknown as { setText: (v: string) => void }).setText(text);
			} else {
				unknown.push(name);
				continue;
			}
			filled.push(name);
		} catch (e) {
			// A closed-set field rejecting a value is worth naming precisely: "Sunday" against a
			// dropdown of ["SAT","SUN"] is a fixable mistake, and a generic failure is not.
			const allowed = (field as unknown as { getOptions?: () => string[] }).getOptions?.();
			throw new PdfFormError(
				`Could not set "${name}" to "${text}"${allowed?.length ? ` — allowed values are: ${allowed.join(", ")}` : ""}. ` +
					`(${e instanceof Error ? e.message : String(e)})`,
			);
		}
	}

	if (opts.flatten !== false) form.flatten();
	const out = await doc.save();
	return {
		bytes: out,
		filled,
		unknown,
		untouched: [...present.keys()].filter((n) => !filled.includes(n)),
	};
}

export interface AnswerEntry {
	label: string;
	value: string;
}

/**
 * Generate a plain answer sheet — the flat-PDF path.
 *
 * Deliberately typographic rather than clever: one page size, one font, wrapped lines, a rule
 * under the title. It exists to be READ by a person who asked for a form back, so legibility is
 * the whole specification.
 *
 * WinAnsi is the encoding StandardFonts can embed, and it cannot represent most non-Latin text.
 * Rather than let `drawText` throw halfway through a document, unrepresentable characters are
 * replaced up front — a visible "?" is a better failure than a 500 with half a PDF written.
 */
export async function buildAnswerDocument(title: string, entries: AnswerEntry[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);

	const A4: [number, number] = [595.28, 841.89];
	const margin = 56;
	const width = A4[0] - margin * 2;
	let page = doc.addPage(A4);
	let y = A4[1] - margin;

	const winAnsi = (s: string) => s.replace(/[^ -~ -ÿ]/g, "?");

	const wrap = (text: string, size: number, f: PDFFont): string[] => {
		const out: string[] = [];
		for (const paragraph of winAnsi(text).split("\n")) {
			let line = "";
			for (const word of paragraph.split(/\s+/)) {
				const candidate = line ? `${line} ${word}` : word;
				if (f.widthOfTextAtSize(candidate, size) > width && line) {
					out.push(line);
					line = word;
				} else {
					line = candidate;
				}
			}
			out.push(line);
		}
		return out;
	};

	const write = (text: string, size: number, f: PDFFont, gap: number) => {
		for (const line of wrap(text, size, f)) {
			if (y < margin + size) {
				page = doc.addPage(A4);
				y = A4[1] - margin;
			}
			page.drawText(line, { x: margin, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
			y -= size + 4;
		}
		y -= gap;
	};

	write(title, 16, bold, 6);
	page.drawLine({
		start: { x: margin, y: y + 6 },
		end: { x: margin + width, y: y + 6 },
		thickness: 0.75,
		color: rgb(0.7, 0.7, 0.7),
	});
	y -= 10;

	for (const entry of entries) {
		write(entry.label, 11, bold, 0);
		write(entry.value || "-", 11, font, 8);
	}

	return doc.save();
}
