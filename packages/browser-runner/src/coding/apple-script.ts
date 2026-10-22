/**
 * AppleScript for iTerm2 without the typed text in any process's argv (#1196).
 *
 * `osascript -e <script>` puts the whole script — and so the text inside it — in a child's argv, where `ps` and
 * `/proc/<pid>/cmdline` show it to any local user. `osascript -` reads the script from STDIN instead, so the only
 * argument is the constant `-`. The text still exists inside the script, in the osascript process and in iTerm2:
 * that is the terminal itself, which is where the owner asked for it to be typed.
 */

/** An AppleScript string expression for `s`, exact for quotes, backslashes, newlines, other control characters and Unicode. */
export function appleString(s: string): string {
	const parts: string[] = [];
	let run = "";
	const flush = () => {
		if (run) parts.push(`"${run}"`);
		run = "";
	};
	for (const ch of s) {
		const code = ch.codePointAt(0) as number;
		if (ch === "\\") run += "\\\\";
		else if (ch === '"') run += '\\"';
		else if (ch === "\n") run += "\\n";
		else if (ch === "\r") run += "\\r";
		else if (ch === "\t") run += "\\t";
		else if (code < 0x20 || code === 0x7f) {
			flush();
			parts.push(`(ASCII character ${code})`);
		} else run += ch;
	}
	flush();
	return parts.length ? parts.join(" & ") : '""';
}

/** The script that writes `text` into an iTerm2 session `w:t:s`. `enter` presses Return after it (iTerm2's default); false does not. */
export function itermWriteScript(target: string, text: string, enter: boolean): string {
	const [w, t, s] = target.split(":").map((v) => Math.max(1, Number.parseInt(v, 10) || 1));
	return ['tell application "iTerm2"', `set theSession to session ${s} of tab ${t} of window ${w}`, `tell theSession to write text ${appleString(text)}${enter ? "" : " newline NO"}`, "end tell"].join("\n");
}
