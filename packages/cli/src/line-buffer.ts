import { StringDecoder } from "node:string_decoder";

/** The longest unterminated line kept; past it the pending text is emitted as a line so memory stays bounded (#1299). */
export const MAX_PENDING_LINE = 64 * 1024;

/**
 * Reassembles a child's output stream into lines (#1299). Node hands over chunks, not lines: a status line can arrive as
 * `PAGS-STATUS regis` + `tration=ok …\n`, and a multi-byte character can be cut between two chunks. One splitter per stream, so
 * a half-line on stdout is never joined to a half-line on stderr.
 *
 * `push` returns only COMPLETE lines (a `\r\n` ending is accepted); `flush` returns the final unterminated line at stream end.
 */
export class LineSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";

	constructor(private readonly maxPending = MAX_PENDING_LINE) {}

	push(chunk: Buffer | string): string[] {
		this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const parts = this.pending.split("\n");
		this.pending = parts.pop() ?? "";
		const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
		// A line that never ends must not grow without bound: emit what is held and carry on from empty.
		while (this.pending.length > this.maxPending) {
			lines.push(this.pending.slice(0, this.maxPending));
			this.pending = this.pending.slice(this.maxPending);
		}
		return lines;
	}

	flush(): string[] {
		const rest = this.pending + this.decoder.end();
		this.pending = "";
		return rest ? [rest.endsWith("\r") ? rest.slice(0, -1) : rest] : [];
	}
}
