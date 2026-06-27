/** Escape HTML entities */
export function esc(s: string): string {
	const d = document.createElement("div");
	d.textContent = s || "";
	return d.innerHTML;
}

/** Escape for use in HTML attributes */
export function escAttr(s: string): string {
	return String(s || "")
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Render markdown-ish text to HTML (for assistant messages) */
export function renderMd(raw: string): string {
	let s = raw || "";

	// Strip embedded tool-call JSON blobs
	s = s.replace(
		/\{[^{}]*"type"\s*:\s*"function"[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*(?:\{[^{}]*\}[^{}]*)*\};?/g,
		(_, name) => `\n\n> *Tool executed: ${name}*\n\n`,
	);

	// Pure JSON response
	const trimmed = s.trim();
	if (/^[{[]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
		try {
			return renderJson(JSON.parse(trimmed));
		} catch {
			/* not JSON */
		}
	}

	// Fenced code blocks
	const codeBlocks: string[] = [];
	s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
		codeBlocks.push(`<pre><code>${esc(code.trim())}</code></pre>`);
		return `@@CODE_BLOCK_${codeBlocks.length - 1}@@`;
	});

	// Inline code
	s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`);

	// Headers
	s = s.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
	s = s.replace(/^###\s+(.+)$/gm, "<h4>$1</h4>");
	s = s.replace(/^##\s+(.+)$/gm, "<h3>$1</h3>");

	// Bold then italic
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

	// Blockquotes
	s = s.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

	// Links
	s = s.replace(
		/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener">$1</a>',
	);
	s = s.replace(
		/(?<![="'/])https?:\/\/[^\s<)"']+/g,
		(u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`,
	);

	// Process lists
	const blocks = s.split(/\n{2,}/);
	const out: string[] = [];
	for (const block of blocks) {
		const lines = block.split("\n");
		if (lines.every((l) => /^[-*]\s+/.test(l.trim()) || !l.trim())) {
			out.push(
				"<ul>" +
					lines
						.filter((l) => l.trim())
						.map((l) => `<li>${l.replace(/^[-*]\s+/, "")}</li>`)
						.join("") +
					"</ul>",
			);
		} else if (
			lines.every((l) => /^\d+\.\s+/.test(l.trim()) || !l.trim())
		) {
			out.push(
				"<ol>" +
					lines
						.filter((l) => l.trim())
						.map((l) => `<li>${l.replace(/^\d+\.\s+/, "")}</li>`)
						.join("") +
					"</ol>",
			);
		} else if (lines.some((l) => /^\s+[-*]\s+/.test(l))) {
			const items: string[] = [];
			for (const l of lines) {
				if (/^[-*]\s+/.test(l.trim()) || /^\s+[-*]\s+/.test(l)) {
					items.push(`<li>${l.replace(/^\s*[-*]\s+/, "")}</li>`);
				} else if (l.trim()) {
					items.push(l);
				}
			}
			out.push("<ul>" + items.join("") + "</ul>");
		} else {
			const text = block.replace(/\n/g, "<br>");
			if (
				text.trim() &&
				!text.startsWith("<h") &&
				!text.startsWith("<blockquote") &&
				!text.startsWith("<ul") &&
				!text.startsWith("<ol")
			) {
				out.push(`<p>${text}</p>`);
			} else {
				out.push(text);
			}
		}
	}
	s = out.join("");

	// Restore code blocks
	s = s.replace(
		/@@CODE_BLOCK_(\d+)@@/g,
		(_, i) => codeBlocks[parseInt(i, 10)],
	);
	s = s.replace(/<p>\s*<\/p>/g, "");
	return s;
}

/** JSON pretty-print with syntax highlighting */
function renderJson(obj: unknown): string {
	const s = JSON.stringify(obj, null, 2);
	const highlighted = esc(s)
		.replace(
			/"([^"]+)"(?=\s*:)/g,
			'<span style="color:#7dd3fc">"$1"</span>',
		)
		.replace(
			/:\s*"([^"]*)"/g,
			': <span style="color:#86efac">"$1"</span>',
		)
		.replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#fbbf24">$1</span>')
		.replace(
			/:\s*(true|false|null)/g,
			': <span style="color:#c084fc">$1</span>',
		);
	return `<pre style="background:#080808;border:1px solid var(--color-line);border-radius:0.5rem;padding:0.75rem;margin:0.5rem 0;overflow-x:auto;font-family:var(--font-mono);font-size:0.8em;line-height:1.6;color:var(--color-muted)">${highlighted}</pre>`;
}

/** Lightweight markdown for co-pilot: bold, code, bullets, linebreaks */
export function mdLite(raw: string): string {
	let s = esc(raw || "");
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
	s = s.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
	s = s.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
	s = s.replace(/\n/g, "<br>");
	return s;
}

/** Relative time label */
export function formatTime(iso: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	const now = Date.now();
	const diff = now - d.getTime();
	if (diff < 60000) return "just now";
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
	return d.toLocaleDateString();
}
