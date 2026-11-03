import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResumeFiles } from "./resume-files.js";

describe("résumé download ownership (#1441)", () => {
	it("same filenames never overwrite another reference, run or agent's uploaded bytes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pags-resumes-"));
		let version = "first";
		const server = createServer((request, response) => {
			response.setHeader("Content-Disposition", 'attachment; filename="resume.pdf"');
			response.end(`${version}:${request.url}`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		const url = `http://127.0.0.1:${address.port}`;
		try {
			const files = new ResumeFiles();
			const a = await files.resolve(`${url}/a`, join(directory, "agent-a"), "run-a");
			const b = await files.resolve(`${url}/b`, join(directory, "agent-a"), "run-a");
			version = "second";
			const nextRun = await files.resolve(`${url}/a`, join(directory, "agent-a"), "run-b");
			const nextAgent = await files.resolve(`${url}/a`, join(directory, "agent-b"), "run-a");
			expect(new Set([a, b, nextRun, nextAgent]).size).toBe(4);
			expect(readFileSync(a!, "utf8")).toBe("first:/a");
			expect(readFileSync(b!, "utf8")).toBe("first:/b");
			expect(readFileSync(nextRun!, "utf8")).toBe("second:/a");
			expect(readFileSync(nextAgent!, "utf8")).toBe("second:/a");
			expect(await files.resolve(`${url}/a`, join(directory, "agent-a"), "run-a")).toBe(a);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
