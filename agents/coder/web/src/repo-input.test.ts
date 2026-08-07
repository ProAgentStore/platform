import { describe, expect, it } from "vitest";
import { type AddRepoBody, parseRepoInput } from "./repo-input";

/**
 * The chain as it stood inside the click handler, transcribed. Everything the two agree on is
 * behaviour this refactor preserved; the disagreements are asserted one by one below.
 */
const previous = (raw: string): AddRepoBody | null => {
	const val = raw.trim();
	if (!val) return null;
	if (val.startsWith("~") || val.startsWith("/")) return { localPath: val };
	if (val.includes("://") || val.includes(".git")) return { cloneUrl: val };
	if (val.includes("/")) return { githubRepo: val, cloneUrl: `https://github.com/${val}.git` };
	return { name: val };
};

describe("the four things one box accepts", () => {
	it("a local checkout on the runner machine", () => {
		expect(parseRepoInput("~/dev/platform")).toEqual({ localPath: "~/dev/platform" });
		expect(parseRepoInput("/Users/me/code/platform")).toEqual({ localPath: "/Users/me/code/platform" });
	});

	it("a clone URL, handed to git as typed", () => {
		expect(parseRepoInput("https://github.com/ProAgentStore/platform.git")).toEqual({
			cloneUrl: "https://github.com/ProAgentStore/platform.git",
		});
		// No `://` in the SSH form — it was only ever caught by the `.git` substring test.
		expect(parseRepoInput("git@github.com:ProAgentStore/platform.git")).toEqual({
			cloneUrl: "git@github.com:ProAgentStore/platform.git",
		});
	});

	it("an owner/repo coordinate, with the clone URL derived rather than typed", () => {
		expect(parseRepoInput("ProAgentStore/platform")).toEqual({
			githubRepo: "ProAgentStore/platform",
			cloneUrl: "https://github.com/ProAgentStore/platform.git",
		});
	});

	it("a bare name, for a repo with no source yet", () => {
		expect(parseRepoInput("scratch")).toEqual({ name: "scratch" });
	});

	it("nothing, for an empty or whitespace box", () => {
		expect(parseRepoInput("")).toBeNull();
		expect(parseRepoInput("   ")).toBeNull();
		// Trimmed before classifying, so a pasted path with a trailing newline is still a path.
		expect(parseRepoInput("  ~/dev/platform\n")).toEqual({ localPath: "~/dev/platform" });
	});
});

describe("the `.git` substring misread", () => {
	// `val.includes(".git")` — a substring test, applied to the most common suffix in the GitHub
	// namespace. Every GitHub Pages user site is called `<user>.github.io`, and `owner/repo.git`
	// is what you get by pasting a clone URL and deleting the host. All three became a
	// `cloneUrl` that is not a URL: `parseGithubRepo` finds no `github.com` in it, so the repo
	// lands with no `githubRepo` (no builds, no issues) and a clone that fails on the runner,
	// well away from the box that accepted it.

	it("a GitHub Pages coordinate is a coordinate", () => {
		expect(previous("torvalds/torvalds.github.io")).toEqual({ cloneUrl: "torvalds/torvalds.github.io" });
		expect(parseRepoInput("torvalds/torvalds.github.io")).toEqual({
			githubRepo: "torvalds/torvalds.github.io",
			cloneUrl: "https://github.com/torvalds/torvalds.github.io.git",
		});
	});

	it("a bare GitHub Pages name is a name", () => {
		expect(previous("mysite.github.io")).toEqual({ cloneUrl: "mysite.github.io" });
		expect(parseRepoInput("mysite.github.io")).toEqual({ name: "mysite.github.io" });
	});

	it("owner/repo.git is the same coordinate with a suffix", () => {
		expect(previous("owner/repo.git")).toEqual({ cloneUrl: "owner/repo.git" });
		expect(parseRepoInput("owner/repo.git")).toEqual({
			githubRepo: "owner/repo",
			cloneUrl: "https://github.com/owner/repo.git",
		});
	});

	it("the suffix is anchored, so a repo that merely CONTAINS .git is unaffected", () => {
		expect(parseRepoInput("owner/dotfiles.gitconfig")).toEqual({
			githubRepo: "owner/dotfiles.gitconfig",
			cloneUrl: "https://github.com/owner/dotfiles.gitconfig.git",
		});
	});
});

describe("the shapes that used to fall through to the wrong branch", () => {
	it("a scheme-less URL becomes a URL, not a literal coordinate", () => {
		// `githubRepo: "github.com/ProAgentStore/platform"` is not a GitHub coordinate, and the
		// derived clone URL doubled the host.
		expect(previous("github.com/ProAgentStore/platform")).toEqual({
			githubRepo: "github.com/ProAgentStore/platform",
			cloneUrl: "https://github.com/github.com/ProAgentStore/platform.git",
		});
		expect(parseRepoInput("github.com/ProAgentStore/platform")).toEqual({
			cloneUrl: "https://github.com/ProAgentStore/platform",
		});
	});

	it("a relative path is a path", () => {
		// It has a slash, so it was read as an `owner/repo` coordinate: a repo named "platform"
		// belonging to an owner called ".".
		expect(previous("./platform")).toEqual({ githubRepo: "./platform", cloneUrl: "https://github.com/./platform.git" });
		expect(parseRepoInput("./platform")).toEqual({ localPath: "./platform" });
		expect(parseRepoInput("../sibling")).toEqual({ localPath: "../sibling" });
	});

	it("a Windows path is a path", () => {
		expect(parseRepoInput("C:\\dev\\platform")).toEqual({ localPath: "C:\\dev\\platform" });
	});

	it("a slashed value that is neither a coordinate nor a host is a name", () => {
		// Sending it as a clone URL asks git to fetch nonsense. A name is at least a repo the
		// user can point at a source afterwards.
		expect(parseRepoInput("a/b/c")).toEqual({ name: "a/b/c" });
		expect(parseRepoInput("My Org/repo")).toEqual({ name: "My Org/repo" });
	});
});

describe("exactly one field, always", () => {
	// The server branches hard on WHICH field arrives: `localPath` means "never clone",
	// `cloneUrl` is handed to git verbatim, `githubRepo` is what unlocks builds and issues.
	const CORPUS = [
		"~/dev/platform",
		"/abs/path",
		"./rel",
		"C:\\dev\\x",
		"https://github.com/o/r.git",
		"git@github.com:o/r.git",
		"o/r",
		"o/r.git",
		"o/r.github.io",
		"github.com/o/r",
		"plain",
		"plain.github.io",
		"a/b/c",
	];

	it("never mixes localPath with a remote", () => {
		for (const v of CORPUS) {
			const body = parseRepoInput(v);
			if (body && "localPath" in body) {
				expect(Object.keys(body)).toEqual(["localPath"]);
			}
		}
	});

	it("a githubRepo always brings a clone URL that resolves back to it", () => {
		for (const v of CORPUS) {
			const body = parseRepoInput(v);
			if (body && "githubRepo" in body) {
				// The same regex `workers/api/src/routes/coding-shared.ts#parseGithubRepo` runs.
				const parsed = body.cloneUrl.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)?.[1];
				expect(parsed).toBe(body.githubRepo);
			}
		}
	});

	it("hands a non-GitHub URL to the server as a bare cloneUrl (#221)", () => {
		// The box needs no provider picker for this to work: the server reads the HOST off the
		// URL (`lib/git-providers.ts#parseRepoRef`) and stores the repo as what it is. What
		// matters here is only that the client does not attach a `githubRepo` to it — that field
		// is what would make a GitLab repo claim to be a GitHub one.
		for (const v of [
			"https://gitlab.com/group/subgroup/project.git",
			"git@gitlab.com:group/project.git",
			"https://bitbucket.org/workspace/repo.git",
			"gitlab.com/group/project",
		]) {
			expect(parseRepoInput(v), v).toEqual({ cloneUrl: v.includes("://") || v.startsWith("git@") ? v : `https://${v}` });
		}
	});

	it("every input produces a body the server has a branch for", () => {
		for (const v of CORPUS) {
			const body = parseRepoInput(v);
			expect(body).not.toBeNull();
			const keys = Object.keys(body as object).sort().join(",");
			expect(["localPath", "cloneUrl", "cloneUrl,githubRepo", "name"]).toContain(keys);
		}
	});
});
