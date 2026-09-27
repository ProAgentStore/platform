/**
 * Separate a shell command's heredoc BODIES from the text that is executed (#873).
 *
 * The act record carries the whole command line, and a heredoc body is data: a commit message, an
 * issue-comment body, a Python script editing a test file. Read as commands, their lines produced
 * acts that never happened ("merged a pull request #3" from a string inside a Python heredoc) and
 * repository targets nobody wrote to (#872, `mcp/apps` from a comment body).
 *
 * VENDORED: `workers/api/src/lib/heredoc.ts` is the original; this is a copy, because a Worker must not
 * import the runner package. `workers/api/src/lib/heredoc.test.ts` runs the same cases through both.
 *
 * The rules, and the one place this is stricter than "strip from `<<` to the terminator":
 *  - `<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` and `<<-WORD` open a heredoc. `<<<` is a
 *    here-string, not a heredoc. Several operators on one line are read in order, as the shell does.
 *  - An operator only counts outside quotes, except inside a `$( … )` substitution, which is how
 *    `git commit -m "$(cat <<'EOF'` is written — a `<<` inside `"a << b"` is not one.
 *  - The body is the lines AFTER the operator's line, up to a line that is exactly the delimiter
 *    (leading tabs allowed for `<<-`). The terminator line is dropped too.
 *  - The REST OF THE OPERATOR'S LINE is executed and kept: `git commit -F - <<'EOF' && git push`
 *    pushes, and dropping it would hide a real act.
 *  - No terminator — the stored command is cut at 400 characters — makes everything after the
 *    operator's line body. A heredoc that never closed cannot have run anything after it that
 *    this text shows.
 */

/** A delimiter, read at the position just after `<<`. */
const DELIMITER = /(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/y;

interface Pending {
	word: string;
	dash: boolean;
}

/** The heredoc operators on one executed line, in order, respecting quotes and `$( … )`. */
function operatorsOn(line: string): Pending[] {
	const out: Pending[] = [];
	// A stack of contexts: "sh" (unquoted, including inside `$( … )`), "dq" and "sq".
	const stack: Array<"sh" | "dq" | "sq"> = ["sh"];
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const top = stack[stack.length - 1];
		if (top === "sq") {
			if (ch === "'") stack.pop();
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			stack.push("sh");
			i++;
			continue;
		}
		if (top === "dq") {
			if (ch === '"') stack.pop();
			continue;
		}
		if (ch === "'") stack.push("sq");
		else if (ch === '"') stack.push("dq");
		else if (ch === ")" && stack.length > 1) stack.pop();
		else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
		else if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
			DELIMITER.lastIndex = i + 2;
			const m = DELIMITER.exec(line);
			const word = m ? (m[2] ?? m[3] ?? m[4]) : undefined;
			if (m && word) {
				out.push({ word, dash: m[1] === "-" });
				i = DELIMITER.lastIndex - 1;
			}
		}
	}
	return out;
}

export interface HeredocSplit {
	/** The command with every heredoc body (and terminator line) removed. */
	executed: string;
	/** The body lines that were removed, joined by newlines. */
	bodies: string;
	/** A heredoc was still open when the text ended — the command was cut inside a body. */
	unterminated: boolean;
	/**
	 * The command with each body collapsed to one `[heredoc body: N lines]` line and its terminator
	 * kept. The runner records THIS as an act's evidence, so the 400-character cap spends itself on
	 * what was executed — a real `git push` after a long commit message survives the cut.
	 */
	elided: string;
}

export function splitHeredocs(command: string): HeredocSplit {
	const executed: string[] = [];
	const bodies: string[] = [];
	const elided: string[] = [];
	const pending: Pending[] = [];
	let bodyLines = 0;
	const marker = () => `[heredoc body: ${bodyLines} line${bodyLines === 1 ? "" : "s"}]`;
	for (const raw of String(command ?? "").split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (pending.length) {
			const { word, dash } = pending[0];
			if ((dash ? line.replace(/^\t+/, "") : line) === word) {
				pending.shift();
				elided.push(marker(), raw);
				bodyLines = 0;
			} else {
				bodies.push(raw);
				bodyLines++;
			}
			continue;
		}
		executed.push(raw);
		elided.push(raw);
		pending.push(...operatorsOn(line));
	}
	if (pending.length) elided.push(marker());
	return { executed: executed.join("\n"), bodies: bodies.join("\n"), unterminated: pending.length > 0, elided: elided.join("\n") };
}
