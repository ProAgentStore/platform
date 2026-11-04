import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PortableDocument } from "../local-artifact/document-contract.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import { parseCloudDocuments, prepareApplyDocuments } from "./documents.js";

// No Markdown stripping, typography replacement, or ASCII-only PDF encoding may change these bytes.
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

/** A controlled employer form: selecting a file succeeds even when its own validation rejects it. */
const form = (extension: ".txt" | ".pdf") => `
<label>Résumé <input type="file" id="resume" accept="${extension}" required></label>
<p role="status"></p><button disabled>Continue</button>
<script>
{
const input = document.querySelector('input');
input.addEventListener('change', () => {
  const file = input.files[0];
  const accepted = !!file && file.name.toLowerCase().endsWith('${extension}');
  input.setCustomValidity(accepted ? '' : 'Unsupported attachment format');
  document.querySelector('[role=status]').textContent = accepted ? 'Accepted ' + file.name : 'Unsupported attachment format';
  document.querySelector('button').disabled = !accepted;
});
}
</script>`;

it("delivers exact approved bytes as TXT to a text-compatible form, without claiming PDF compatibility (#1473)", async () => {
	const documents = [document("resume"), document("cover_letter"), document("profile")];
	const artifacts = documents.slice(0, 2).map((doc) => ({ kind: doc.role as "resume" | "cover_letter", path: `~/canonical/${doc.name}`, sha256: doc.sha256 }));
	const input = { artifacts, cloudDocuments: parseCloudDocuments(documents, artifacts) } as LocalApplyTaskEnvelope;
	const prepared = prepareApplyDocuments(input, dir, join(dir, "missing-home"), () => undefined);
	const resume = prepared.artifactPath("resume");
	const cover = prepared.artifactPath("cover_letter");
	if (!("path" in resume) || !("path" in cover)) throw new Error("Expected verified staged documents");
	expect(basename(resume.path)).toBe("resume.txt");
	expect(basename(cover.path)).toBe("cover-letter.txt");
	expect(readFileSync(resume.path)).toEqual(Buffer.from(TEXT, "utf8"));
	expect(resume.sha256).toBe(documents[0].sha256);
	expect(documents[0].name).toBe("resume.md");
	expect(documents[0].mimeType).toBe("text/markdown");
	const original = join(dir, "resume.md");
	writeFileSync(original, Buffer.from(TEXT, "utf8"));
	const page = await browser.newPage();
	try {
		await page.setContent(form(".txt"));
		// The browser accepts file selection, but the form rejects the original Markdown extension.
		await page.locator("input").setInputFiles(original);
		expect(await page.getByRole("status").textContent()).toBe("Unsupported attachment format");
		expect(await page.getByRole("button", { name: "Continue" }).isDisabled()).toBe(true);
		await page.locator("input").setInputFiles(resume.path);
		expect(await page.getByRole("status").textContent()).toBe("Accepted resume.txt");
		expect(await page.getByRole("button", { name: "Continue" }).isDisabled()).toBe(false);
		const received = await page.locator("input").evaluate(async (element: HTMLInputElement) => {
			const file = element.files![0];
			return { name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
		});
		expect(received.type).toBe("text/plain");
		expect(sha256(Buffer.from(received.bytes))).toBe(resume.sha256);
		// TXT is not a universal fallback. A PDF-only form still rejects it and blocks continuation.
		await page.setContent(form(".pdf"));
		await page.locator("input").setInputFiles(resume.path);
		expect(await page.getByRole("status").textContent()).toBe("Unsupported attachment format");
		expect(await page.getByRole("button", { name: "Continue" }).isDisabled()).toBe(true);
	} finally { await page.close(); }
});
