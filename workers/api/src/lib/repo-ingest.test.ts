import { describe, expect, it } from "vitest";
import { buildRepoOverview, extractTextFiles, findReadme, parseGithubUrl } from "./repo-ingest.js";

describe("parseGithubUrl", () => {
	it("parses https, .git, ssh, shorthand; rejects junk", () => {
		expect(parseGithubUrl("https://github.com/octocat/Spoon-Knife")).toEqual({ owner: "octocat", repo: "Spoon-Knife" });
		expect(parseGithubUrl("https://github.com/sindresorhus/slugify.git")).toEqual({ owner: "sindresorhus", repo: "slugify" });
		expect(parseGithubUrl("https://github.com/a/b/tree/main/src")).toEqual({ owner: "a", repo: "b" });
		expect(parseGithubUrl("git@github.com:foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
		expect(parseGithubUrl("foo/bar")).toEqual({ owner: "foo", repo: "bar" });
		expect(parseGithubUrl("not a url")).toBeNull();
		expect(parseGithubUrl("")).toBeNull();
	});
});

// Build a minimal ustar tar (readTar ignores the checksum, so we leave it blank).
function tarHeader(name: string, size: number, type = "0"): Uint8Array {
	const h = new Uint8Array(512);
	const enc = new TextEncoder();
	h.set(enc.encode(name).slice(0, 100), 0);
	h.set(enc.encode(size.toString(8).padStart(11, "0")), 124); // size, octal
	h.set(enc.encode(type), 156);
	return h;
}
function tarEntry(name: string, content: string, type = "0"): Uint8Array {
	const body = new TextEncoder().encode(content);
	const padded = Math.ceil(body.length / 512) * 512;
	const out = new Uint8Array(512 + padded);
	out.set(tarHeader(name, body.length, type), 0);
	out.set(body, 512);
	return out;
}
function makeTar(entries: Uint8Array[]): Uint8Array {
	const end = new Uint8Array(1024); // two zero blocks
	const parts = [...entries, end];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const tar = new Uint8Array(total);
	let off = 0;
	for (const p of parts) { tar.set(p, off); off += p.length; }
	return tar;
}

describe("extractTextFiles", () => {
	const TOP = "owner-repo-abc123";
	const tar = makeTar([
		tarEntry(`${TOP}/`, "", "5"), // directory
		tarEntry(`${TOP}/src/index.ts`, "export const x = 1;\n"),
		tarEntry(`${TOP}/README.md`, "# Title\nhello"),
		tarEntry(`${TOP}/package.json`, '{"name":"x"}'),
		tarEntry(`${TOP}/node_modules/dep/index.js`, "module.exports = 1"), // denied dir
		tarEntry(`${TOP}/dist/bundle.js`, "compiled"), // denied dir
		tarEntry(`${TOP}/pnpm-lock.yaml`, "lockfile contents"), // denied file
		tarEntry(`${TOP}/logo.png`, "PNGDATA"), // non-text extension
		tarEntry(`${TOP}/bin/blob`, "ab\0cd"), // binary content (NUL)
		tarEntry(`${TOP}/.gitignore`, "node_modules\n"),
	]);

	it("keeps text/code files, strips the top dir, drops vendored/binary/lockfiles", () => {
		const { files } = extractTextFiles(tar, { maxFiles: 100, maxFileBytes: 1000, maxTotalBytes: 100000 });
		const paths = files.map((f) => f.path).sort();
		expect(paths).toEqual([".gitignore", "README.md", "package.json", "src/index.ts"]);
		// Top-level dir prefix is stripped.
		expect(paths.some((p) => p.startsWith(TOP))).toBe(false);
	});

	it("honours the file count cap and reports skipped", () => {
		const { files, skipped } = extractTextFiles(tar, { maxFiles: 2, maxFileBytes: 1000, maxTotalBytes: 100000 });
		expect(files.length).toBe(2);
		expect(skipped).toBeGreaterThan(0);
	});

	it("truncates oversized files", () => {
		const big = makeTar([tarEntry(`${TOP}/big.txt`, "A".repeat(5000))]);
		const { files } = extractTextFiles(big, { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 100000 });
		expect(files[0].content.length).toBeLessThan(200);
		expect(files[0].content).toContain("truncated");
	});

	it("findReadme + buildRepoOverview surface repo structure", () => {
		const { files } = extractTextFiles(tar, { maxFiles: 100, maxFileBytes: 1000, maxTotalBytes: 100000 });
		expect(findReadme(files)).toContain("# Title");
		const overview = buildRepoOverview({ owner: "owner", repo: "repo" }, {
			description: "a repo",
			language: "TypeScript",
			paths: files.map((f) => f.path),
			readme: findReadme(files),
		});
		expect(overview).toContain("owner/repo");
		expect(overview).toContain("src/index.ts");
		expect(overview).toContain("# Title");
	});
});
