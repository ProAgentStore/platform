/**
 * Render raw tmux pane output as colorized HTML: format inline code/bold/JSON
 * and tint lines by kind (prompt, error, tool, success, …). Pure — no React, so
 * it's unit-testable on its own. Consumed by <TerminalView> via dangerouslySetInnerHTML.
 */
export function renderTerminal(text: string): string {
	// Extract and format JSON blocks inline
	const s = text.replace(/(?:^|\n)(\{[\s\S]*?\}|\[[\s\S]*?\])(?=\n|$)/g, (match) => {
		try {
			const obj = JSON.parse(match.trim());
			const pretty = JSON.stringify(obj, null, 2);
			const esc = pretty.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			return `\n<code style="color:#94a3b8;font-size:0.75em">${esc}</code>\n`;
		} catch { return match; }
	});

	return s.split("\n").map((line) => {
		let e = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		// Skip already-formatted code blocks
		if (line.startsWith("<code")) return line;
		// Inline bold
		e = e.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		// Inline code
		e = e.replace(/`([^`]+)`/g, '<code style="background:#1e1e2e;padding:1px 4px;border-radius:3px;font-size:0.85em">$1</code>');
		// Headings (### → bold colored)
		if (/^\s*#{1,4}\s+/.test(line)) {
			const heading = e.replace(/^\s*#+\s+/, "");
			return `<strong style="color:#7dd3fc;font-size:1.05em">${heading}</strong>`;
		}
		// Prompt lines (cyan)
		if (/^\s*❯/.test(line)) return `<span style="color:#67e8f9">${e}</span>`;
		// Error lines (red)
		if (/^\s*\[error\]|^Error:|^✗|^FAIL/i.test(line)) return `<span style="color:#f87171">${e}</span>`;
		// Tool/system lines (amber)
		if (/^\s*⚙|^\s*\[info\]|^\s*\[warn\]|^\[/.test(line)) return `<span style="color:#fbbf24">${e}</span>`;
		// Continuation/result lines (dim)
		if (/^\s*↳|^\s*│|^\s*└|^\s*├/.test(line)) return `<span style="color:#94a3b8">${e}</span>`;
		// Success lines (green)
		if (/^\s*✓|^\s*✔|^PASS|^Done/i.test(line)) return `<span style="color:#4ade80">${e}</span>`;
		// Bullet points
		if (/^\s*[-*]\s+/.test(line)) return `<span style="color:#c4b5fd">${e}</span>`;
		// Default
		return `<span style="color:#d6d6e0">${e}</span>`;
	}).join("\n");
}
