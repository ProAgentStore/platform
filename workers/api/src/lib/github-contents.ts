/**
 * Read a file, or list a directory, in a REMOTE GitHub repository at any ref (#1110).
 *
 * Every repository read a Coder had was local: `repo_read_file`, `repo_tree` and friends act on the
 * one checkout the instance is bound to. The `github_*` tools reach any repo the owner's GitHub App
 * installation covers, but none of them took a path — so a workflow file in another repo (the
 * interns app's `.github/workflows/*.yml`, the reusable `app-ci.yml` it calls) could not be read by
 * any tool at all. These two close that, over the SAME installation token the other `github_*` reads
 * use: no new scope, no new grant, and a repo the installation does not cover answers 404.
 *
 * The file is windowed by line exactly like `repo_read_file` (`renderRepoFileWindow`), and both
 * results are the repository's text, so the connector marks them `untrustedOutput` and the registry
 * fences them; the head and the continuation hint stay outside the fence.
 */
import type { RegistryToolResult } from "./connectors/types.js";
import { renderRepoFileWindow } from "./repo-file-window.js";

/** The most of one file this reads — GitHub's own inline-content limit for the contents API. */
export const GITHUB_FILE_MAX_BYTES = 1024 * 1024;
/** The contents API lists at most this many entries of one directory. */
export const GITHUB_DIR_MAX_ENTRIES = 1000;

const headers = (token: string, accept = "application/vnd.github+json") => ({
	Authorization: `token ${token}`,
	Accept: accept,
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-connector/1.0",
});

const num = (n: number): string => n.toLocaleString("en-US");

/**
 * A repo-relative path as URL segments, or an error. `..` and `.` segments are refused rather than
 * normalised: GitHub would resolve neither, and a path that names its parent is a caller mistake
 * worth stating. Each segment is percent-encoded, so nothing in a path can become query or fragment.
 */
export function contentsPath(raw: unknown): { path: string; encoded: string } | { error: string } {
	const path = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
	if (!path) return { path: "", encoded: "" };
	const segments = path.split("/");
	if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || [...s].some((ch) => ch.charCodeAt(0) < 0x20))) {
		return { error: `Invalid path "${String(raw)}" — give a path relative to the repository root, like ".github/workflows/ci.yml", with no "." or ".." segments.` };
	}
	return { path, encoded: segments.map(encodeURIComponent).join("/") };
}

/** A branch, tag or commit SHA, or an error. Absent → the repository's default branch. */
export function contentsRef(raw: unknown): { ref: string } | { error: string } {
	if (raw === undefined || raw === null || String(raw).trim() === "") return { ref: "" };
	const ref = String(raw).trim();
	if (ref.length > 250 || ref.startsWith("-") || ref.includes("..") || !/^[A-Za-z0-9._/@+-]+$/.test(ref)) {
		return { error: `Invalid ref "${ref}" — give a branch, tag or commit SHA (e.g. "main", "v1.2.0", "3f2a9c1").` };
	}
	return { ref };
}

const contentsUrl = (repo: string, encoded: string, ref: string) => `https://api.github.com/repos/${repo}/contents/${encoded}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
const where = (repo: string, path: string, ref: string) => `${path || "/"} in ${repo}${ref ? ` at ${ref}` : " (default branch)"}`;

function notFound(repo: string, path: string, ref: string): RegistryToolResult {
	return {
		content: `Not found: ${where(repo, path, ref)}. Either the path or ref does not exist, or the GitHub App installation does not cover ${repo} — this tool reads only repositories the installation was granted. List a directory with github_tree to check the path.`,
		success: false,
	};
}

interface ContentEntry {
	type?: string;
	name?: string;
	path?: string;
	size?: number;
	sha?: string;
	encoding?: string;
	content?: string;
	html_url?: string;
}

async function getContents(repo: string, encoded: string, ref: string, token: string): Promise<{ status: number; body: ContentEntry | ContentEntry[] | null } | { unreachable: true }> {
	const res = await fetch(contentsUrl(repo, encoded, ref), { headers: headers(token), signal: AbortSignal.timeout(15_000) }).catch(() => null);
	if (!res) return { unreachable: true };
	if (!res.ok) return { status: res.status, body: null };
	return { status: res.status, body: (await res.json().catch(() => null)) as ContentEntry | ContentEntry[] | null };
}

function failure(repo: string, path: string, ref: string, r: { status: number } | { unreachable: true }): RegistryToolResult {
	if ("unreachable" in r) return { content: `Could not reach GitHub for ${repo} just now — try again.`, success: false };
	if (r.status === 404) return notFound(repo, path, ref);
	return { content: `GitHub returned ${r.status} reading ${where(repo, path, ref)}.`, success: false };
}

/** Read up to `cap` bytes of a body — a file over the cap is never pulled whole across the wire. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array(await res.arrayBuffer()).subarray(0, cap);
	const out = new Uint8Array(cap);
	let used = 0;
	while (used < cap) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		const take = Math.min(value.length, cap - used);
		out.set(value.subarray(0, take), used);
		used += take;
	}
	await reader.cancel().catch(() => undefined);
	return out.subarray(0, used);
}

const base64Bytes = (b64: string) => Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));

/** Binary: a NUL in the first 8KB, or bytes that are not UTF-8 — the same test git applies. */
function decodeText(bytes: Uint8Array, cut: boolean): string | null {
	if (bytes.subarray(0, 8000).includes(0)) return null;
	try {
		// A byte cap can split a multi-byte character at the very end; that tail alone is not "binary".
		return new TextDecoder("utf-8", { fatal: !cut, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

export async function readGithubFile(repo: string, token: string, input: Record<string, unknown>): Promise<RegistryToolResult> {
	const p = contentsPath(input.path);
	if ("error" in p) return { content: p.error, success: false };
	if (!p.path) return { content: "A file `path` is required — to list the repository root, call github_tree.", success: false };
	const r = contentsRef(input.ref);
	if ("error" in r) return { content: r.error, success: false };
	const { path } = p;
	const { ref } = r;

	const got = await getContents(repo, p.encoded, ref, token);
	if (!("body" in got)) return failure(repo, path, ref, got);
	if (got.status !== 200 || !got.body) return failure(repo, path, ref, { status: got.status });
	if (Array.isArray(got.body)) return { content: `${where(repo, path, ref)} is a directory — list it with github_tree repo="${repo}" path="${path}"${ref ? ` ref="${ref}"` : ""}.`, success: false };
	const entry = got.body;
	if (entry.type !== "file") return { content: `${where(repo, path, ref)} is a ${entry.type ?? "non-file entry"} (e.g. a symlink or submodule), not a file this tool can read.`, success: false };

	const size = Number(entry.size) || 0;
	let bytes: Uint8Array;
	if (entry.encoding === "base64" && typeof entry.content === "string") {
		bytes = base64Bytes(entry.content);
	} else {
		// Over GitHub's 1MB inline limit the API sends no content; the raw media type does, and only the
		// first GITHUB_FILE_MAX_BYTES of it are read.
		const raw = await fetch(contentsUrl(repo, p.encoded, ref), { headers: headers(token, "application/vnd.github.raw"), signal: AbortSignal.timeout(30_000) }).catch(() => null);
		if (!raw) return failure(repo, path, ref, { unreachable: true });
		if (!raw.ok) return failure(repo, path, ref, { status: raw.status });
		bytes = await readCapped(raw, GITHUB_FILE_MAX_BYTES);
	}
	const cut = size > bytes.length;
	const text = decodeText(bytes, cut);
	const label = `${repo}:${path}${ref ? `@${ref}` : ""}`;
	if (text === null) {
		return { content: `${label} is a binary file (${num(size)} bytes, sha ${entry.sha ?? "unknown"}) — its content is not returned as text.${entry.html_url ? ` It is at ${entry.html_url}.` : ""}`, success: true };
	}

	const lines = text.split("\n");
	if (text.endsWith("\n") || (cut && lines.length > 1)) lines.pop(); // a final newline, or a line the byte cap split
	const kept = cut ? lines.join("\n") : text;
	const win = renderRepoFileWindow({
		path: label,
		content: kept,
		startLine: input.startLine,
		endLine: input.endLine,
		firstLine: 1,
		totalLines: text === "" ? 0 : lines.length,
		nextCall: `github_read_file repo="${repo}" path="${path}"${ref ? ` ref="${ref}"` : ""}`,
		jumpHint: "",
	});
	if (!win.success || !cut) return { ...win, origin: `${label} on GitHub` };
	return {
		...win,
		head: `This file is ${num(size)} bytes; only its first ${num(GITHUB_FILE_MAX_BYTES)} bytes — lines 1-${num(lines.length)} — can be read through this tool. Do NOT state or imply that the file ends at line ${num(lines.length)}.\n${win.head ?? ""}`,
		origin: `${label} on GitHub`,
	};
}

export async function listGithubTree(repo: string, token: string, input: Record<string, unknown>): Promise<RegistryToolResult> {
	const p = contentsPath(input.path);
	if ("error" in p) return { content: p.error, success: false };
	const r = contentsRef(input.ref);
	if ("error" in r) return { content: r.error, success: false };
	const { path } = p;
	const { ref } = r;

	const got = await getContents(repo, p.encoded, ref, token);
	if (!("body" in got)) return failure(repo, path, ref, got);
	if (got.status !== 200 || !got.body) return failure(repo, path, ref, { status: got.status });
	if (!Array.isArray(got.body)) return { content: `${where(repo, path, ref)} is a ${got.body.type ?? "file"}, not a directory — read it with github_read_file repo="${repo}" path="${path}"${ref ? ` ref="${ref}"` : ""}.`, success: false };

	const entries = [...got.body].sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
	const head = `--- ${where(repo, path, ref)} — ${num(entries.length)} entr${entries.length === 1 ? "y" : "ies"} (directories first; read a file with github_read_file, list a subdirectory with github_tree path="<its path>") ---${entries.length >= GITHUB_DIR_MAX_ENTRIES ? `\nGitHub lists at most ${num(GITHUB_DIR_MAX_ENTRIES)} entries of one directory; this one may hold more.` : ""}`;
	if (!entries.length) return { head: `${head}\n(this directory is empty)`, content: "", success: true };
	const body = entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.type === "file" ? `${e.path}  (${num(Number(e.size) || 0)} bytes)` : `${e.path}  [${e.type}]`)).join("\n");
	return { head, content: body, success: true, origin: `the listing of ${where(repo, path, ref)} on GitHub` };
}
