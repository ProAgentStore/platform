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

/**
 * The control character an iTerm2 key name stands for, in the names `tmux_send_keys` / `terminal_send_keys` use (#1144):
 * Enter, Escape, Tab, and `C-a` … `C-z` (so C-u clears the line, C-c interrupts, C-d ends input). Anything else is not
 * guessed at: iTerm2's `write text` can only type characters, so a key with no character (arrows, function keys) is refused.
 */
export function itermKeyCode(key: string): number | null {
	const k = key.trim();
	if (/^(?:enter|return)$/i.test(k)) return 13;
	if (/^(?:escape|esc)$/i.test(k)) return 27;
	if (/^tab$/i.test(k)) return 9;
	if (/^(?:bspace|backspace)$/i.test(k)) return 127;
	const ctrl = /^(?:C-|\^)([a-z])$/i.exec(k);
	return ctrl ? ctrl[1].toLowerCase().charCodeAt(0) - 96 : null;
}

/** The script that types `text` (when given, without Return) and then each key into an iTerm2 session `w:t:s`. Every write is `newline NO`: a key is exactly the character it names. */
export function itermKeysScript(target: string, text: string | undefined, keys: string[]): string {
	const [w, t, s] = target.split(":").map((v) => Math.max(1, Number.parseInt(v, 10) || 1));
	const writes: string[] = [];
	if (text) writes.push(`tell theSession to write text ${appleString(text)} newline NO`);
	for (const key of keys) {
		const code = itermKeyCode(key);
		if (code == null) throw new RangeError(`iTerm2 cannot send the key "${key}" — supported: Enter, Escape, Tab, BSpace and C-a … C-z.`);
		writes.push(`tell theSession to write text (ASCII character ${code}) newline NO`);
	}
	return ['tell application "iTerm2"', `set theSession to session ${s} of tab ${t} of window ${w}`, ...writes, "end tell"].join("\n");
}
