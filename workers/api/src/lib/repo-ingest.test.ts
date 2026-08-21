import { describe, expect, it } from "vitest";
import { githubAccessDenial, type GithubAccessState } from "./github-app.js";
import { buildRepoOverview, extractTextFiles, findReadme, parseGithubUrl, repoDownloadFailure } from "./repo-ingest.js";

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

/**
 * The 404 that told an owner with SIXTEEN GitHub App installations to "connect GitHub" (#724).
 *
 * `installationTokenForOwner` collapses five conditions into `string | null`, so by the time
 * `fetchRepoTarball` raised a 404 the reason the token was absent had been discarded and one
 * hardcoded sentence answered all of them. The sentence named a remedy already performed and
 * never named the one that would work — install the App on THAT owner, which was `TheRocketLab`
 * and is not one of the sixteen.
 *
 * Pinned per condition, because — exactly as `githubAccessDenial`'s own tests say — the wording
 * IS the bug.
 */
describe("repoDownloadFailure — the refusal names the condition that actually stopped it", () => {
	const ref = { owner: "TheRocketLab", repo: "mountain-unlocked" };

	/**
	 * Value-level exhaustiveness over `GithubAccessState`. A sixth state added to `github-app.ts`
	 * fails to COMPILE here (the CI step that typechecks worker tests, #599), and if one were
	 * added without a branch in `repoDownloadFailure` it would fall to the undiagnosed default —
	 * which is what the "never says connect GitHub" test below catches. Two independent guards on
	 * the same drift, because this is the drift that produced the bug.
	 */
	const ALL_STATES: Record<GithubAccessState, true> = {
		"app-not-configured": true,
		"owner-unknown": true,
		"not-installed": true,
		"not-authorized": true,
		transient: true,
	};
	const states = Object.keys(ALL_STATES) as GithubAccessState[];
	/** Exactly what the route hands down: the denial's own state and remedy, not a paraphrase. */
	const diagnosed = (state: GithubAccessState) => {
		const d = githubAccessDenial({ state, owner: ref.owner, installUrl: "https://github.com/apps/pags/installations/new" });
		return { authenticated: false, state: d.state, remedy: d.remedy };
	};

	// THE DELIVERABLE. Every diagnosed refusal knows whether GitHub is reachable for this owner,
	// so none of them may fall back to advice that assumes it is not connected. A new state that
	// slips through the switch lands on the undiagnosed sentence and fails right here.
	it("no diagnosed refusal ever tells the owner to connect GitHub", () => {
		for (const state of states) {
			const msg = repoDownloadFailure(404, ref, diagnosed(state));
			expect(msg, `state ${state}`).not.toMatch(/connect GitHub/i);
		}
		expect(repoDownloadFailure(404, ref, { authenticated: true })).not.toMatch(/connect GitHub/i);
	});

	it("no installation for that owner: names the owner and says to install the App THERE", () => {
		const msg = repoDownloadFailure(404, ref, diagnosed("not-installed"));
		expect(msg).toContain("TheRocketLab/mountain-unlocked (404)");
		expect(msg).toMatch(/not installed on "TheRocketLab"/);
		expect(msg).toContain("https://github.com/apps/pags/installations/new");
		// Honest about the ambiguity GitHub deliberately creates: 404 is also what a repo that
		// does not exist returns, and the reported repo could not be reached from the owner's own
		// `gh` identity either. Asserting "it is private" would have been a guess.
		expect(msg).toMatch(/Either there is no repository at that name, or it is private/);
	});

	it("an installation IS present: the App reached the owner, so it is the repo that is missing", () => {
		const msg = repoDownloadFailure(404, ref, { authenticated: true });
		expect(msg).toMatch(/does have access to "TheRocketLab"/);
		expect(msg).toMatch(/not one of the repositories selected in that installation/);
		expect(msg).not.toMatch(/not installed/);
	});

	it("installed but this account is not authorized keeps the two apart", () => {
		const msg = repoDownloadFailure(404, ref, diagnosed("not-authorized"));
		expect(msg).toMatch(/is installed on "TheRocketLab"/);
		expect(msg).toMatch(/not authorized to use that installation/);
	});

	it("an owner GitHub says does not exist is a wrong URL, not a permission to grant", () => {
		const msg = repoDownloadFailure(404, ref, diagnosed("owner-unknown"));
		expect(msg).toMatch(/not a GitHub account or organisation/);
		expect(msg).toMatch(/nothing to grant/);
		expect(msg).not.toMatch(/install/i);
	});

	it("no diagnosis at all keeps the old wording — nothing was tried, so nothing more can be said", () => {
		const msg = repoDownloadFailure(404, ref);
		expect(msg).toBe('Could not download TheRocketLab/mountain-unlocked (404). Check the URL is a public repo, or connect GitHub for private repos.');
		// A job queued before #724 shipped carries no `auth`, and must degrade to exactly this.
		expect(repoDownloadFailure(404, ref, null)).toBe(msg);
	});

	it("a non-404 does not borrow the 404's inference about which repo is missing", () => {
		expect(repoDownloadFailure(500, ref, { authenticated: true })).not.toMatch(/repositories selected/);
		expect(repoDownloadFailure(500, ref, { authenticated: true })).toContain("(500)");
	});

	it("every state produces a distinct sentence — the collapse is what the bug was", () => {
		const msgs = states.map((s) => repoDownloadFailure(404, ref, diagnosed(s)));
		expect(new Set(msgs).size).toBe(states.length);
	});
});
