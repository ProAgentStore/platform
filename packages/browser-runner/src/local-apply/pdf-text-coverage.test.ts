import { expect, it } from "vitest";
import { assertPdfTextCoverage, PdfTextCoverageError, verifyPdfTextCoverage } from "./pdf-text-coverage.js";

it("accepts ordered approved blocks despite print whitespace, generated list markers and Latin ligatures", () => {
	expect(() => assertPdfTextCoverage(["Résumé", "First office fact", "Second fact: Україна"], "Résumé\n• First ofﬁce\n fact\n4. Second fact: Україна")).not.toThrow();
});

it.each(["Engineer · \u0000\u0000", "Engineer · \uFFFD\uFFFD", "Engineer"])("refuses missing mixed-script characters in extracted output %j", (text) => {
	expect(() => assertPdfTextCoverage(["Engineer · 技術"], text)).toThrow(PdfTextCoverageError);
	try { assertPdfTextCoverage(["Engineer · 技術"], text); } catch (error) {
		expect(error).toMatchObject({ code: "pdf_text_coverage", problem: "missing_characters", missingCodePoints: expect.arrayContaining(["U+6280", "U+8853"]) });
	}
});

it.each(["Second fact First fact", "First fact First fact", "First fact\u0000Second fact", "First fact\uFFFDSecond fact"])("refuses reordered, repeated or corrupt extracted text %j", (text) => {
	expect(() => assertPdfTextCoverage(["First fact", "Second fact"], text)).toThrow(PdfTextCoverageError);
});

it("refuses vacuous empty document coverage", () => {
 expect(() => assertPdfTextCoverage([" \n\t"], "")).toThrow(PdfTextCoverageError);
});

it("refuses unparseable output and preserves Stop cancellation", async () => {
	await expect(verifyPdfTextCoverage(Buffer.from("not a PDF"), ["Approved fact"])).rejects.toMatchObject({ code: "pdf_text_coverage", problem: "unreadable_pdf" });
	const stop = new AbortController(); stop.abort();
	await expect(verifyPdfTextCoverage(Buffer.from("not a PDF"), ["Approved fact"], stop.signal)).rejects.toHaveProperty("name", "AbortError");
});
