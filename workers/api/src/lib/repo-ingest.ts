/**
 * Repo ingestion helpers — fetch a GitHub repo as a single tarball, gunzip it
 * in-Worker, parse the (ustar) tar, and filter down to the text/code files worth
 * indexing for RAG chat.
 *
 * Why the tarball and not the git trees + blobs API: a recursive ingest of a real
 * repo is hundreds of files. Unauthenticated GitHub API is capped at 60 req/hour,
 * so per-file blob fetches would rate-limit instantly. The tarball is ONE request
 * for the whole tree, public repos included.
 */

export interface RepoRef {
	owner: string;
	repo: string;
}

export interface ExtractedFile {
	path: string;
	content: string;
}

export interface ExtractResult {
	files: ExtractedFile[];
	/** Files that matched a code/text pattern but were dropped (size/count caps). */
	skipped: number;
}

const GH_API = "https://api.github.com";

/** Directories never worth indexing (dependencies, build output, VCS internals). */
const DENY_DIRS = new Set([
	"node_modules", ".git", ".github", "dist", "build", "out", "vendor", ".next",
	".nuxt", ".svelte-kit", "target", "bin", "obj", "__pycache__", ".venv", "venv",
	"env", "coverage", ".cache", ".turbo", ".gradle", "Pods", "DerivedData",
	".idea", ".vscode", "tmp", ".terraform",
]);

/** Lockfiles + generated junk: large, low signal, skip even if the extension matches. */
const DENY_FILES = new Set([
	"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock",
	"poetry.lock", "composer.lock", "Gemfile.lock", "go.sum", "flake.lock",
]);

/** Extensions we treat as text/code worth embedding. */
const TEXT_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "py", "rb", "go",
	"rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "php",
	"scala", "clj", "ex", "exs", "erl", "hs", "lua", "r", "dart", "sh", "bash",
	"zsh", "fish", "ps1", "sql", "graphql", "gql", "proto", "html", "htm", "css",
	"scss", "sass", "less", "vue", "svelte", "astro", "md", "mdx", "markdown",
	"rst", "txt", "toml", "yaml", "yml", "ini", "cfg", "conf", "env", "xml",
	"gradle", "tf", "tfvars", "dockerfile", "makefile", "cmake", "bat", "csv",
]);

/** Filenames with no extension that are still text. */
const TEXT_NAMES = new Set([
	"readme", "license", "licence", "dockerfile", "makefile", "procfile",
	"gemfile", "rakefile", "changelog", "contributing", "authors", "notice",
	".gitignore", ".dockerignore", ".npmrc", ".nvmrc", ".editorconfig",
	".env.example", ".prettierrc", ".eslintrc",
]);

/** Parse a GitHub repo reference from a URL, `owner/repo`, or git remote. */
export function parseGithubUrl(input: string): RepoRef | null {
	const raw = input.trim();
	if (!raw) return null;

	// git@github.com:owner/repo.git
	const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
	if (ssh) return { owner: ssh[1], repo: ssh[2] };

	// https://github.com/owner/repo(/...)?
	const url = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
	if (url) return { owner: url[1], repo: url[2].replace(/\.git$/i, "") };

	// owner/repo shorthand
	const short = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
	if (short) return { owner: short[1], repo: short[2] };

	return null;
}

const GH_HEADERS = (token?: string): Record<string, string> => ({
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-repo-chat/1.0",
	...(token ? { Authorization: `token ${token}` } : {}),
});

/** Repo metadata used for the overview doc (best-effort, never throws). */
export interface RepoMeta {
	description: string | null;
	defaultBranch: string | null;
	language: string | null;
	stars: number | null;
	private: boolean;
}

export async function fetchRepoMeta(ref: RepoRef, token?: string): Promise<RepoMeta | null> {
	try {
		const res = await fetch(`${GH_API}/repos/${ref.owner}/${ref.repo}`, { headers: GH_HEADERS(token) });
		if (!res.ok) return null;
		const d = (await res.json()) as Record<string, unknown>;
		return {
			description: (d.description as string) ?? null,
			defaultBranch: (d.default_branch as string) ?? null,
			language: (d.language as string) ?? null,
			stars: (d.stargazers_count as number) ?? null,
			private: Boolean(d.private),
		};
	} catch {
		return null;
	}
}

/** Fetch + gunzip the repo tarball. Returns the raw tar bytes. */
export async function fetchRepoTarball(ref: RepoRef, branch?: string, token?: string): Promise<Uint8Array> {
	const path = branch
		? `${GH_API}/repos/${ref.owner}/${ref.repo}/tarball/${encodeURIComponent(branch)}`
		: `${GH_API}/repos/${ref.owner}/${ref.repo}/tarball`;
	const res = await fetch(path, { headers: GH_HEADERS(token) });
	if (!res.ok || !res.body) {
		throw new Error(`Could not download repository (${res.status}). Check the URL is a public repo, or connect GitHub for private repos.`);
	}
	const gunzipped = res.body.pipeThrough(new DecompressionStream("gzip"));
	// Read the decompressed stream incrementally with a hard ceiling. `.arrayBuffer()`
	// buffers the WHOLE inflated tarball first, so a gzip bomb (or just a very large repo)
	// could blow the Worker isolate's memory BEFORE any per-file/total cap in
	// extractTextFiles applies — the caps gave a false sense of protection. Abort early.
	// Well under the Worker isolate's ~128MB budget: we accumulate chunks in `parts` AND
	// then copy into `out`, so peak memory is ~2× this. 128MB would OOM-crash the isolate
	// (60–128MB band) BEFORE this guard could return the clean error — defeating its purpose.
	// 48MB (≈96MB peak) is still generous vs the ~4MB extract cap.
	const MAX_TAR_BYTES = 48 * 1024 * 1024;
	const reader = gunzipped.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_TAR_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new Error("Repository is too large to index (its decompressed archive exceeds the size limit).");
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}

interface TarEntry {
	name: string;
	type: string;
	data: Uint8Array;
}

/** Minimal ustar/GNU tar reader — enough for GitHub's repo tarballs. */
function* readTar(tar: Uint8Array): Generator<TarEntry> {
	const dec = new TextDecoder();
	let offset = 0;
	let longName: string | null = null;

	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		// Two consecutive zero blocks mark end of archive.
		if (header.every((b) => b === 0)) break;

		const readStr = (start: number, len: number) => dec.decode(header.subarray(start, start + len)).replace(/\0.*$/, "").trim();
		let name = readStr(0, 100);
		const prefix = readStr(345, 155);
		if (prefix) name = `${prefix}/${name}`;
		const sizeOctal = readStr(124, 12);
		const size = parseInt(sizeOctal || "0", 8) || 0;
		const type = String.fromCharCode(header[156] || 0x30);

		const dataStart = offset + 512;
		const data = tar.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / 512) * 512;

		if (type === "L") {
			// GNU long name: this entry's data IS the next entry's name.
			longName = dec.decode(data).replace(/\0.*$/, "");
			continue;
		}
		if (type === "g" || type === "x") continue; // pax headers
		if (longName) {
			name = longName;
			longName = null;
		}
		yield { name, type, data };
	}
}

/** Strip GitHub's top-level `owner-repo-sha/` directory prefix. */
function stripTopDir(name: string): string {
	const slash = name.indexOf("/");
	return slash === -1 ? name : name.slice(slash + 1);
}

function isTextPath(path: string): boolean {
	const segments = path.split("/");
	for (const seg of segments.slice(0, -1)) {
		if (DENY_DIRS.has(seg)) return false;
	}
	const file = segments[segments.length - 1];
	if (!file || DENY_FILES.has(file)) return false;
	const lower = file.toLowerCase();
	if (TEXT_NAMES.has(lower)) return true;
	const dot = lower.lastIndexOf(".");
	if (dot === -1) return false;
	return TEXT_EXT.has(lower.slice(dot + 1));
}

function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 1024);
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
	return false;
}

export interface ExtractOpts {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

/** Parse a tar buffer into the text files worth indexing, honouring caps. */
export function extractTextFiles(tar: Uint8Array, opts: ExtractOpts): ExtractResult {
	const dec = new TextDecoder();
	const files: ExtractedFile[] = [];
	let skipped = 0;
	let total = 0;

	for (const entry of readTar(tar)) {
		if (entry.type !== "0" && entry.type !== "\0" && entry.type.charCodeAt(0) !== 0) continue;
		const path = stripTopDir(entry.name);
		if (!path || !isTextPath(path)) continue;
		if (entry.data.length === 0) continue;
		if (looksBinary(entry.data)) continue;

		if (files.length >= opts.maxFiles || total >= opts.maxTotalBytes) {
			skipped++;
			continue;
		}
		let content = dec.decode(entry.data);
		if (content.length > opts.maxFileBytes) {
			content = `${content.slice(0, opts.maxFileBytes)}\n…[file truncated for indexing]`;
		}
		files.push({ path, content });
		total += content.length;
	}

	return { files, skipped };
}

/** Pick the top-level README content from a set of files, if present. */
export function findReadme(files: ExtractedFile[]): string | null {
	const readme = files.find((f) => /(^|\/)readme(\.|$)/i.test(f.path));
	return readme ? readme.content.slice(0, 4000) : null;
}

export interface OverviewInput {
	description?: string | null;
	language?: string | null;
	paths: string[];
	readme?: string | null;
}

/** Build a human-readable overview of the repo for the knowledge base. */
export function buildRepoOverview(ref: RepoRef, input: OverviewInput): string {
	const lines: string[] = [];
	lines.push(`# Repository: ${ref.owner}/${ref.repo}`);
	if (input.description) lines.push(`\n${input.description}`);
	if (input.language) lines.push(`\nPrimary language (per GitHub): ${input.language}`);

	// Language breakdown by extension.
	const byExt = new Map<string, number>();
	for (const p of input.paths) {
		const dot = p.lastIndexOf(".");
		const ext = dot === -1 ? "(none)" : p.slice(dot + 1).toLowerCase();
		byExt.set(ext, (byExt.get(ext) || 0) + 1);
	}
	const top = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
	if (top.length) {
		lines.push(`\n## File types (${input.paths.length} files indexed)`);
		lines.push(top.map(([ext, n]) => `- .${ext}: ${n}`).join("\n"));
	}

	if (input.readme) {
		lines.push("\n## README (excerpt)");
		lines.push(input.readme);
	}

	// File tree (paths only, capped).
	lines.push("\n## Files");
	const sorted = [...input.paths].sort();
	lines.push(sorted.slice(0, 250).join("\n"));
	if (sorted.length > 250) lines.push(`…and ${sorted.length - 250} more`);

	return lines.join("\n");
}
