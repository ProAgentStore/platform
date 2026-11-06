import { extractText } from "unpdf";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { documentHtml, renderDocumentPdf } from "./document-pdf.js";
import { PdfTextCoverageError, verifyPdfTextCoverage } from "./pdf-text-coverage.js";

it("renders searchable Unicode text across multiple pages without dropping the final source facts", async () => {
	const paragraphs = Array.from({ length: 120 }, (_, index) => `- Project ${index + 1}: delivered independently supported work, preserving the complete approved statement.`);
	const bytes = await renderDocumentPdf(`# Zoë — Résumé\n\n**Engineer** · Україна\n\n## Experience\n${paragraphs.join("\n")}\n\nFinal approved fact: Étude complète.`, true);
	expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
	const result = await extractText(new Uint8Array(bytes), { mergePages: true });
	expect(result.totalPages).toBeGreaterThan(1);
	const text = result.text.replace(/\s+/g, " ");
	for (const expected of ["Zoë", "Résumé", "Engineer", "Україна", "Final approved fact: Étude complète."]) expect(text).toContain(expected);
	for (let index = 1; index <= 120; index++) expect(text).toContain(`Project ${index}: delivered independently supported work`);
	// Real, valid PDF bytes cannot pass verification against characters absent from the output.
	await expect(verifyPdfTextCoverage(bytes, ["技術"])).rejects.toMatchObject({ problem: "missing_characters", missingCodePoints: ["U+6280", "U+8853"] });
}, 60_000);

it("preserves mixed-script text or explicitly refuses missing host glyphs before returning an attachment (#1572)", async () => {
 const source = "# Zoë — Résumé\n\nEngineer · Україна · 技術";
 let bytes: Buffer;
 try { bytes = await renderDocumentPdf(source, true); }
 catch (error) {
  expect(error).toBeInstanceOf(PdfTextCoverageError);
  expect(error).toMatchObject({ code: "pdf_text_coverage", problem: "missing_characters", missingCodePoints: ["U+6280", "U+8853"] });
  return;
 }
 const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
 for (const expected of ["Zoë", "Résumé", "Україна", "技術"]) expect(text).toContain(expected);
 expect(text).not.toContain("\u0000");
 expect(text).not.toContain("\uFFFD");
}, 60_000);

it("escapes raw HTML and never creates executable or external-resource document elements", async () => {
	const source = '# Literal evidence\n\n<script>window.executed = true</script>\n<img src="https://assets.example.test/private.png" onerror="window.executed = true">\n[Profile](https://example.test/profile)\n![Portrait](https://assets.example.test/portrait.png)\n\n4. Fourth approved item\n5. Fifth approved item';
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const requests: string[] = [];
		await page.route("**/*", (route) => { requests.push(route.request().url()); return route.abort(); });
		await page.setContent(documentHtml(source), { waitUntil: "load" });
		expect(await page.locator("script,img,iframe,object,embed,link,a").count()).toBe(0);
		expect(await page.evaluate(() => (window as Window & { executed?: boolean }).executed)).toBeUndefined();
		expect(await page.locator("body").innerText()).toContain('<script>window.executed = true</script>');
		expect(await page.locator("body").innerText()).toContain("Profile (https://example.test/profile)");
		expect(await page.locator("body").innerText()).toContain("Portrait (https://assets.example.test/portrait.png)");
		expect(await page.locator("ol").getAttribute("start")).toBe("4");
		expect(await page.locator("ol li").allTextContents()).toEqual(["Fourth approved item", "Fifth approved item"]);
		expect(requests).toEqual([]);
	} finally { await browser.close(); }
}, 60_000);

it("formats plain-text source literally rather than interpreting its Markdown-looking content", async () => {
	const source = "# Literal heading\n**Literal asterisks**\n<Do not execute>\nFinal fact: 25% & €150.";
	const bytes = await renderDocumentPdf(source, false);
	const result = await extractText(new Uint8Array(bytes), { mergePages: true });
	for (const expected of ["# Literal heading", "**Literal asterisks**", "<Do not execute>", "Final fact: 25% & €150."]) expect(result.text).toContain(expected);
}, 60_000);
