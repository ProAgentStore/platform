/**
 * Test helper: the npm argv a call MEANT, whatever shape the host wrapped it in (#1725).
 *
 * `runNpm` hands `execFile` a different thing per platform (`npmInvocation`, payload.ts): plain `npm <args>` off Windows, the
 * npm-cli.js path then `<args>` when Node can run npm's own script, or `cmd.exe /d /s /c "npm <quoted, caret-escaped args>"`
 * when it cannot. A test that records what `execFile` received and compares it to `["install", "--prefix", …]` is only right on
 * the first; this undoes the other two so the same expectation holds on a real Windows host.
 */

/** Undo `quoteCmdArg`'s two caret layers, then split on the CRT's quoting rules. */
function splitCmdLine(line: string): string[] {
	const text = line.replace(/\^(.)/g, "$1").replace(/\^(.)/g, "$1");
	const out: string[] = [];
	let cur = "";
	let inQuote = false;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			let n = 0;
			while (text[i] === "\\") {
				n++;
				i++;
			}
			if (text[i] === '"') {
				cur += "\\".repeat(Math.floor(n / 2));
				if (n % 2) cur += '"';
				else inQuote = !inQuote;
			} else {
				cur += "\\".repeat(n);
				i--;
			}
			started = true;
		} else if (c === '"') {
			inQuote = !inQuote;
			started = true;
		} else if (c === " " && !inQuote) {
			if (started) out.push(cur);
			cur = "";
			started = false;
		} else {
			cur += c;
			started = true;
		}
	}
	if (started) out.push(cur);
	return out;
}

/** The arguments npm itself receives, given what `execFile` was handed to run it. */
export function npmArgv(file: string, args: string[]): string[] {
	if (/cmd(\.exe)?$/i.test(file) && args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
		const line = args[3].replace(/^"/, "").replace(/"$/, "");
		return splitCmdLine(line).slice(1); // drop the leading `npm`
	}
	if (/npm-cli\.js$/i.test(args[0] ?? "")) return args.slice(1);
	return args;
}
