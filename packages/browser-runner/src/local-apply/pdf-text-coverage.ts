import { extractText, getDocumentProxy } from "unpdf";

export type PdfTextCoverageProblem = "missing_characters" | "sequence_mismatch" | "unreadable_pdf";
export class PdfTextCoverageError extends Error {
	readonly code = "pdf_text_coverage";
	constructor(readonly problem: PdfTextCoverageProblem, readonly missingCodePoints: string[] = []) {
		super(problem === "unreadable_pdf"
			? "The generated PDF could not be text-verified. No attachment was prepared."
			: `The generated PDF did not preserve the approved text (${problem}; ${missingCodePoints.length} missing code points). Install local fonts supporting the source characters and retry. No attachment was prepared.`);
		this.name = "PdfTextCoverageError";
	}
}

/** Only layout whitespace and canonical/typographic Latin ligatures are equivalent here.
 * Never discard scripts, punctuation, replacement glyphs, accents or semantic source content. */
function comparable(text: string): string {
	const ligatures: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
	return text.normalize("NFC").replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/gu, (char) => ligatures[char]).replace(/\s/gu, "");
}

/** Checks owned renderer leaf blocks in order. Generated list markers may appear between
 * blocks, but no non-layout character within an approved block may disappear or change order.
 * This establishes extractable text coverage, not visual correctness or qualification accuracy. */
export function assertPdfTextCoverage(expectedBlocks: readonly string[], extractedText: string): void {
	const expected = expectedBlocks.map(comparable).filter(Boolean), actual = comparable(extractedText);
	if (!expected.length) throw new PdfTextCoverageError("sequence_mismatch");
	const actualCodePoints = new Set(actual);
	const missing = [...new Set([...expected.join("")].filter((char) => !actualCodePoints.has(char)))].map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
	if (missing.length) throw new PdfTextCoverageError("missing_characters", missing);
	if ((actual.includes("\u0000") && !expected.some((block) => block.includes("\u0000"))) || (actual.includes("\uFFFD") && !expected.some((block) => block.includes("\uFFFD")))) throw new PdfTextCoverageError("sequence_mismatch");
	let offset = 0;
	for (const block of expected) {
		const found = actual.indexOf(block, offset);
		if (found < 0) throw new PdfTextCoverageError("sequence_mismatch");
		offset = found + block.length;
	}
}

/** Parse the actual output bytes, releasing PDF.js resources on completion or Stop. */
export async function verifyPdfTextCoverage(bytes: Buffer, expectedBlocks: readonly string[], signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
	let destruction: Promise<void> | undefined;
	const destroy = () => {
		if (!document) return Promise.resolve();
		destruction ??= document.destroy();
		return destruction;
	};
	const abort = () => { void destroy().catch(() => undefined); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		// Copy: PDF.js may transfer/detach its input; the upload bytes must remain unchanged.
		document = await getDocumentProxy(new Uint8Array(bytes));
		signal?.throwIfAborted();
		const { text } = await extractText(document, { mergePages: true });
		signal?.throwIfAborted();
		assertPdfTextCoverage(expectedBlocks, text);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof PdfTextCoverageError) throw error;
		throw new PdfTextCoverageError("unreadable_pdf");
	} finally {
		signal?.removeEventListener("abort", abort);
		// Cleanup must not replace a typed fidelity refusal or owner cancellation.
		await destroy().catch(() => undefined);
	}
}
