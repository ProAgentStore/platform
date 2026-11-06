import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PortableDocument } from "../local-artifact/document-contract.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import { PDF_RENDERER_REVISION } from "./document-pdf.js";
import { parseCloudDocuments, prepareApplyDocuments } from "./documents.js";

const TEXT = "# Synthetic Résumé\n\n**Engineer** — 2021–2024\n- UI/UX, testing, and data science\n- 技術 / Україна\n";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const document = (role: PortableDocument["role"]): PortableDocument => {
	const bytes = Buffer.from(TEXT, "utf8");
	return { role, name: `${role}.md`, mimeType: "text/markdown", sha256: sha256(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
};
let browser: Browser;
let dir: string;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "pags-format-")); browser = await chromium.launch({ headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); }, 60_000);

/** A controlled attachment validator; selecting a file is separate from website acceptance. */
const form = `
<label>Document <input type="file" accept=".pdf,application/pdf" required></label>
<p role="status"></p><button disabled>Continue</button>
<script>
document.querySelector('input').addEventListener('change', event => {
  const file = event.target.files[0];
  const accepted = !!file && file.name.toLowerCase().endsWith('.pdf') && file.type === 'application/pdf';
  event.target.setCustomValidity(accepted ? '' : 'Unsupported attachment format');
  document.querySelector('[role=status]').textContent = accepted ? 'Accepted ' + file.name : 'Unsupported attachment format';
  document.querySelector('button').disabled = !accepted;
});
</script>`;

it("selects genuine PDF résumé and cover-letter bytes while retaining the approved Markdown identity (#1570)", async () => {
	const documents = [document("resume"), document("cover_letter"), document("profile")];
	const artifacts = documents.slice(0, 2).map((doc) => ({ kind: doc.role as "resume" | "cover_letter", path: `~/canonical/${doc.name}`, sha256: doc.sha256 }));
	const input = {
		artifacts, cloudDocuments: parseCloudDocuments(documents, artifacts),
		policy: { mode: "fill_and_review", allowDomains: ["example.test"], browserCommandTimeoutSeconds: 600 },
		limits: { maxMinutes: 10, maxActions: 20, maxPages: 10 },
	} as LocalApplyTaskEnvelope;
	const prepared = await prepareApplyDocuments(input, dir, join(dir, "missing-home"), () => undefined);
	const original = join(dir, "not-a-professional-attachment.txt");
	writeFileSync(original, Buffer.from(TEXT, "utf8"));
	expect(prepared.blocks.find((block) => block.label === "resume")?.text).toBe(TEXT);
	const page = await browser.newPage();
	try {
		await page.setContent(form);
		await page.locator("input").setInputFiles(original);
		expect(await page.getByRole("status").textContent()).toBe("Unsupported attachment format");
		expect(await page.getByRole("button", { name: "Continue" }).isDisabled()).toBe(true);
		for (const kind of ["resume", "cover_letter"] as const) {
			const upload = prepared.artifactPath(kind);
			if (!("path" in upload)) throw new Error(upload.error);
			const source = documents.find((doc) => doc.role === kind)!;
			const bytes = readFileSync(upload.path);
			expect(basename(upload.path)).toBe(kind === "resume" ? "resume.pdf" : "cover-letter.pdf");
			expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
			expect(upload.sha256).toBe(sha256(bytes));
			expect(upload.sha256).not.toBe(source.sha256);
			expect(upload).toMatchObject({ sourceSha256: source.sha256, rendererRevision: PDF_RENDERER_REVISION, mimeType: "application/pdf", bytes: bytes.length });
			await page.locator("input").setInputFiles(upload.path);
			expect(await page.getByRole("status").textContent()).toBe(`Accepted ${basename(upload.path)}`);
			expect(await page.getByRole("button", { name: "Continue" }).isDisabled()).toBe(false);
			const received = await page.locator("input").evaluate(async (element: HTMLInputElement) => {
				const file = element.files![0];
				return { name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
			});
			expect(received.type).toBe("application/pdf");
			expect(sha256(Buffer.from(received.bytes))).toBe(upload.sha256);
		}
	} finally { await page.close(); }
}, 60_000);
