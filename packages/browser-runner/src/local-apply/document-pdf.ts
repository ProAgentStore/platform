import { existsSync } from "node:fs";
import { chromium } from "playwright";

export const PDF_RENDERER_REVISION = "application_pdf_v1";
export type DocumentPdfRenderer = (text: string, markdown: boolean, signal?: AbortSignal, timeoutMs?: number) => Promise<Buffer>;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A deliberately small document grammar. Escape first; never execute raw HTML, load assets,
 * rewrite facts, infer sections, strip tool-looking text, or embed links/media from the source. */
export function documentHtml(text: string, markdown = true): string {
	const inline = (value: string) => escapeHtml(value)
		.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_]+)__/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
	const blocks: string[] = [];
	let paragraph: string[] = [], list: string[] = [], ordered = false, orderedStart = 1, fenced = false, code: string[] = [];
	const flushParagraph = () => { if (paragraph.length) { blocks.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; } };
	const flushList = () => { if (list.length) { const tag = ordered ? "ol" : "ul"; blocks.push(`<${tag}${ordered ? ` start="${orderedStart}"` : ""}>${list.map((line) => `<li>${inline(line)}</li>`).join("")}</${tag}>`); list = []; } };
	if (!markdown) blocks.push(`<pre class="plain">${escapeHtml(text)}</pre>`);
	else for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (/^\s*```/.test(line)) { flushParagraph(); flushList(); if (fenced) { blocks.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`); code = []; } fenced = !fenced; continue; }
		if (fenced) { code.push(line); continue; }
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		const bullet = /^\s*(?:([-+*])\s+|(\d+)\.\s+)(.+)$/.exec(line);
		if (!line.trim()) { flushParagraph(); flushList(); }
		else if (heading) { flushParagraph(); flushList(); blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
		else if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { flushParagraph(); flushList(); blocks.push("<hr>"); }
		else if (bullet) { flushParagraph(); const nextOrdered = !!bullet[2]; if (list.length && nextOrdered !== ordered) flushList(); ordered = nextOrdered; if (!list.length && ordered) orderedStart = Number(bullet[2]); list.push(bullet[3]); }
		else { flushList(); paragraph.push(line); }
	}
	if (fenced) blocks.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
	flushParagraph(); flushList();
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
@page{size:A4;margin:17mm 18mm}*{box-sizing:border-box}body{margin:0;color:#17212b;font:10.5pt/1.42 Arial,"Noto Sans","Arial Unicode MS",sans-serif}h1{font-size:23pt;line-height:1.15;margin:0 0 8pt}h2{font-size:13pt;margin:16pt 0 6pt;border-bottom:1px solid #b8c1ca;padding-bottom:3pt}h3,h4,h5,h6{font-size:11pt;margin:11pt 0 4pt}h1,h2,h3,h4,h5,h6{break-after:avoid}p{margin:0 0 8pt;orphans:3;widows:3}ul,ol{margin:4pt 0 9pt;padding-left:17pt}li{margin:0 0 4pt;orphans:2;widows:2}hr{border:0;border-top:1px solid #d3d9df;margin:11pt 0}pre,code{font-family:"DejaVu Sans Mono",monospace;font-size:9pt}pre{white-space:pre-wrap;overflow-wrap:anywhere}.plain{font:inherit}p,li,h1,h2,h3,h4,h5,h6{overflow-wrap:anywhere}strong{font-weight:700}
</style></head><body>${blocks.join("\n")}</body></html>`;
}

/** A fresh, offline print context is separate from the employer browser and its cookies. */
export const renderDocumentPdf: DocumentPdfRenderer = async (text, markdown, stopSignal, timeoutMs = 600000) => {
	const signal = stopSignal ? AbortSignal.any([stopSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
	signal.throwIfAborted();
	const browser = await chromium.launch({ headless: true, timeout: timeoutMs, ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }) });
	const abort = () => { void browser.close().catch(() => undefined); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const context = await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block" });
		await context.route("**/*", (route) => route.abort());
		const page = await context.newPage();
		page.setDefaultTimeout(timeoutMs); page.setDefaultNavigationTimeout(timeoutMs);
		await page.setContent(documentHtml(text, markdown), { waitUntil: "load" });
		await page.emulateMedia({ media: "print" });
		const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true });
		if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !bytes.includes(Buffer.from("%%EOF"))) throw new Error("Renderer did not produce a complete PDF");
		return bytes;
	} finally { signal.removeEventListener("abort", abort); await browser.close(); }
};

/** Even an injected renderer that ignores cancellation cannot resume staging after Stop. */
export async function renderWithSignal(renderer: DocumentPdfRenderer, text: string, markdown: boolean, stopSignal?: AbortSignal, timeoutMs = 600000): Promise<Buffer> {
	const signal = stopSignal ? AbortSignal.any([stopSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
	signal.throwIfAborted();
	return new Promise<Buffer>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Document rendering stopped"));
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve().then(() => { signal.throwIfAborted(); return renderer(text, markdown, signal, timeoutMs); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
