/**
 * Render raw terminal / tmux pane output as colorized HTML.
 *
 * Pure and framework-free, so both the console and any agent UI can use it. It previously lived
 * inside one agent's package, which is why the console rendered terminal tails as an uncolorized
 * `<pre>` while the Coder colorized the same bytes — the first concrete case of a generic block
 * having nowhere shared to live (#187).
 *
 * SECURITY. The result is consumed via `dangerouslySetInnerHTML`, so every byte of input must be
 * escaped. The original detected its own generated JSON blocks by sniffing
 * `line.startsWith("<code")` and returned those lines UNESCAPED — but engine output is not
 * trusted input. A coding agent reads repository files, so a line beginning
 * `<code><img src=x onerror=...>` was injected verbatim into the console origin. Generated blocks
 * are now held aside under a sentinel and re-inserted only AFTER escaping, so nothing on the raw
 * path can reach them.
 *
 * That claim is what {@link SafeHtml} names: the result is minted through `sanitizedHtml` here,
 * and `SafeHtmlView` accepts nothing else — so the escaping above is the only thing a reviewer
 * has to check, rather than every pane that renders a tail.
 */

import { type SafeHtml, sanitizedHtml } from "./safe-html.js";

const ESC_RE = /[&<>]/g;
const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeHtml = (s: string): string => s.replace(ESC_RE, (c) => ESC_MAP[c]);

/**
 * Marker for a pre-rendered JSON block, carrying a PER-CALL nonce.
 *
 * A fixed marker is forgeable: input containing it renders into the same wrapper the
 * re-insertion regex looks for, so a crafted line could delete itself or swap in another
 * block's content. A nonce the caller cannot predict removes that entirely — this is a
 * bounded, mechanical trick, so it should not depend on the input never containing a
 * particular string.
 */
function makeNonce(): string {
	const g = globalThis as { crypto?: { randomUUID?: () => string } };
	return g.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function renderTerminal(text: string): SafeHtml {
	const blocks: string[] = [];
	const nonce = makeNonce();
	const BLOCK = (i: number) => ` TERMBLOCK-${nonce}-${i} `;
	const BLOCK_RE = new RegExp(`<span style="color:#d6d6e0"> TERMBLOCK-${nonce}-(\\d+) </span>`, "g");

	// Pretty-print standalone JSON, stashing the (already-escaped) result behind a marker.
	const withMarkers = String(text ?? "").replace(/(?:^|\n)(\{[\s\S]*?\}|\[[\s\S]*?\])(?=\n|$)/g, (match) => {
		try {
			const pretty = JSON.stringify(JSON.parse(match.trim()), null, 2);
			blocks.push(`<code style="color:#94a3b8;font-size:0.75em">${escapeHtml(pretty)}</code>`);
			return `\n${BLOCK(blocks.length - 1)}\n`;
		} catch {
			return match; // not JSON after all — leave it to the normal escaped path
		}
	});

	const rendered = withMarkers
		.split("\n")
		.map((line) => {
			let e = escapeHtml(line);
			e = e.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			e = e.replace(/`([^`]+)`/g, '<code style="background:#1e1e2e;padding:1px 4px;border-radius:3px;font-size:0.85em">$1</code>');
			if (/^\s*#{1,4}\s+/.test(line)) return `<strong style="color:#7dd3fc;font-size:1.05em">${e.replace(/^\s*#+\s+/, "")}</strong>`;
			if (/^\s*❯/.test(line)) return `<span style="color:#67e8f9">${e}</span>`;
			if (/^\s*\[error\]|^Error:|^✗|^FAIL/i.test(line)) return `<span style="color:#f87171">${e}</span>`;
			if (/^\s*⚙|^\s*\[info\]|^\s*\[warn\]|^\[/.test(line)) return `<span style="color:#fbbf24">${e}</span>`;
			if (/^\s*↳|^\s*│|^\s*└|^\s*├/.test(line)) return `<span style="color:#94a3b8">${e}</span>`;
			if (/^\s*✓|^\s*✔|^PASS|^Done/i.test(line)) return `<span style="color:#4ade80">${e}</span>`;
			if (/^\s*[-*]\s+/.test(line)) return `<span style="color:#c4b5fd">${e}</span>`;
			return `<span style="color:#d6d6e0">${e}</span>`;
		})
		.join("\n");

	return sanitizedHtml(rendered.replace(BLOCK_RE, (_m, i) => blocks[Number(i)] ?? ""));
}

/** A short, plain-text tail — for compact previews that must never render HTML. */
export function terminalTail(text: string, chars = 400): string {
	const s = String(text ?? "");
	return s.length > chars ? s.slice(-chars) : s;
}
