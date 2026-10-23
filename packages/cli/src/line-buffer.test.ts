/**
 * #1299 — `pags up` reads its child's output as chunks. The same output, cut at every possible byte, must produce the same lines
 * (and so the same status and logs) as unsplit; stdout and stderr never share a half-line.
 */
import { describe, expect, it } from "vitest";
import { LineSplitter, MAX_PENDING_LINE } from "./line-buffer.js";
import { formatStatusLine, parseStatusLine } from "./commands/runner/status-line.js";

const STATUS = formatStatusLine({ registration: "ok", agents: "3/3" });
const SESSION = "STATUS runner-session=0f8fad5b-d9cb-469f-a165-70867728950e";
const ERROR = "[runner] could not start (listen): Error: listen EADDRINUSE: address already in use 127.0.0.1:49171";
const UNICODE = "Registered ✓ — café 日本語 🚀";

function run(chunks: Buffer[]): string[] {
	const s = new LineSplitter();
	return [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
}
const whole = (text: string) => run([Buffer.from(text)]);

describe("LineSplitter (#1299)", () => {
	const text = `${SESSION}\n${STATUS}\n${ERROR}\n${UNICODE}\n`;
	const bytes = Buffer.from(text);

	it("gives the same lines as unsplit input when cut at EVERY byte position — including inside a multi-byte character", () => {
		const expected = whole(text);
		expect(expected).toEqual([SESSION, STATUS, ERROR, UNICODE]);
		for (let i = 0; i <= bytes.length; i++) {
			expect(run([bytes.subarray(0, i), bytes.subarray(i)])).toEqual(expected);
		}
	});

	it("survives one byte at a time", () => {
		expect(run(Array.from(bytes, (b) => Buffer.from([b])))).toEqual(whole(text));
	});

	it("the split registration line still parses as the registration it is (the reported failure)", () => {
		const cut = STATUS.indexOf("registration") + 4;
		const lines = run([Buffer.from(`${STATUS.slice(0, cut)}`), Buffer.from(`${STATUS.slice(cut)}\n`)]);
		expect(lines).toEqual([STATUS]);
		expect(parseStatusLine(lines[0])).toEqual(parseStatusLine(STATUS));
		expect(parseStatusLine(lines[0])).toMatchObject({ registration: "ok" });
	});

	it("several lines in one chunk, blank lines and CRLF endings", () => {
		expect(run([Buffer.from(`a\r\nb\n\nc\n`)])).toEqual(["a", "b", "", "c"]);
	});

	it("an unterminated final line is held until flush, then delivered once", () => {
		const s = new LineSplitter();
		expect(s.push(Buffer.from("done\nlast words"))).toEqual(["done"]);
		expect(s.flush()).toEqual(["last words"]);
		expect(s.flush()).toEqual([]);
	});

	it("a split character at the very end is completed by flush, not lost", () => {
		const bytes2 = Buffer.from("ok ✓");
		const s = new LineSplitter();
		expect(s.push(bytes2.subarray(0, bytes2.length - 1))).toEqual([]);
		expect(s.flush().join("")).toContain("ok ");
	});

	it("separate streams keep separate partial lines: a stdout half and a stderr half never join", () => {
		const out = new LineSplitter();
		const err = new LineSplitter();
		expect(out.push(Buffer.from("PAGS-STATUS regis"))).toEqual([]);
		expect(err.push(Buffer.from("boom: fai"))).toEqual([]);
		expect(err.push(Buffer.from("led\n"))).toEqual(["boom: failed"]);
		expect(out.push(Buffer.from("tration=ok\n"))).toEqual(["PAGS-STATUS registration=ok"]);
	});

	it("a line that never ends is emitted in bounded pieces, not accumulated forever", () => {
		const s = new LineSplitter(10);
		const lines = s.push(Buffer.from("x".repeat(35)));
		expect(lines).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(10)]);
		expect(s.flush()).toEqual(["xxxxx"]);
		expect(MAX_PENDING_LINE).toBeGreaterThan(1024);
	});
});
