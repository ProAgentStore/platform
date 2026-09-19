import { describe, expect, it } from "vitest";
import {
	MAX_SSH_HOSTS,
	httpsLoginFrom,
	isSshCloneUrl,
	sshHostFor,
	sshHostGroups,
	sshIdentityIssues,
	type GitIdentityProbe,
} from "./ssh-identity.js";

const probe = (over: Partial<GitIdentityProbe> = {}): GitIdentityProbe => ({
	checked: true,
	host: "github.com",
	identity: "serge-ivo",
	isDeployKey: false,
	...over,
});

describe("sshHostFor — the host a repo actually talks to", () => {
	it("reads an SSH host ALIAS as itself, not as github.com", () => {
		// The whole bug. `github-personal` is a `~/.ssh/config` stanza with its own key; resolving
		// it to github.com on this side would reintroduce the conflation being removed.
		expect(sshHostFor("git@github-personal:ProAgentStore/platform.git")).toBe("github-personal");
		expect(sshHostFor("git@github-work:acme/api.git")).toBe("github-work");
	});

	it("reads the plain and ssh:// forms, with a port and without .git", () => {
		expect(sshHostFor("git@github.com:owner/repo.git")).toBe("github.com");
		expect(sshHostFor("ssh://git@github.com/owner/repo.git")).toBe("github.com");
		expect(sshHostFor("ssh://git@git.example.com:2222/owner/repo")).toBe("git.example.com");
	});

	it("is null for every non-SSH input — https is a different transport with a different identity", () => {
		for (const u of ["https://github.com/owner/repo.git", "owner/repo", "", null, undefined]) {
			expect(sshHostFor(u)).toBeNull();
		}
		expect(isSshCloneUrl("https://github.com/owner/repo.git")).toBe(false);
		expect(isSshCloneUrl("git@github.com:owner/repo.git")).toBe(true);
	});
});

describe("sshHostGroups", () => {
	it("groups by host in first-seen order and ignores non-SSH repos", () => {
		expect(
			sshHostGroups([
				{ name: "platform", cloneUrl: "git@github-personal:ProAgentStore/platform.git" },
				{ name: "www", cloneUrl: "https://github.com/acme/www.git" },
				{ name: "api", cloneUrl: "git@github-work:acme/api.git" },
				{ name: "sdk", cloneUrl: "git@github-personal:acme/sdk.git" },
			]),
		).toEqual([
			{ host: "github-personal", repos: ["platform", "sdk"] },
			{ host: "github-work", repos: ["api"] },
		]);
	});

	it("drops a repo whose host cannot be named rather than pooling it", () => {
		// We cannot probe a host we cannot name, and a group nobody can check would render as a
		// verdict nobody measured.
		expect(sshHostGroups([{ name: "x", cloneUrl: "git@" }, { name: "y", cloneUrl: null }])).toEqual([]);
	});
});

describe("sshIdentityIssues — the two errors the machine-wide verdict produced", () => {
	const personal = [{ host: "github-personal", repos: ["platform"] }];

	it("does NOT warn about a working alias because bare github.com has no key", () => {
		// The false positive, reproduced. On the machine this was found on, `ssh -T git@github.com`
		// returns "Permission denied (publickey)" while every clone and push over
		// git@github-personal works. The old code probed github.com, got null, and reported that
		// "private repo clones will fail" about a machine that was pushing fine.
		const byHost = new Map<string, GitIdentityProbe | null>([
			["github-personal", probe({ host: "github-personal" })],
			["github.com", probe({ host: "github.com", identity: null, isDeployKey: null })],
		]);
		expect(sshIdentityIssues(personal, byHost)).toEqual([]);
	});

	it("DOES warn about a deploy key on the alias the repo really uses", () => {
		// The false negative, and it is #684's own bug one alias away: a deploy key on
		// github-work while github.com resolves to a user account emitted nothing at all.
		const byHost = new Map<string, GitIdentityProbe | null>([
			["github-work", probe({ host: "github-work", identity: "jobsearch-works/shared", isDeployKey: true })],
			["github.com", probe()],
		]);
		const [issue] = sshIdentityIssues([{ host: "github-work", repos: ["api", "web"] }], byHost);
		expect(issue.severity).toBe("warn");
		expect(issue.message).toContain("github-work");
		expect(issue.message).toContain("jobsearch-works/shared");
		expect(issue.message).toContain('"api", "web"');
		// The host it names must be the one it measured, not the default it used to assume.
		expect(issue.message).not.toContain("github.com");
		expect(issue.fix).toContain("Host github-work");
	});

	it("names the failing host in the no-identity warning", () => {
		const byHost = new Map<string, GitIdentityProbe | null>([
			["github-work", probe({ host: "github-work", identity: null, isDeployKey: null })],
		]);
		const [issue] = sshIdentityIssues([{ host: "github-work", repos: ["api"] }], byHost);
		expect(issue.message).toContain("SSH handshake to github-work");
		expect(issue.fix).toContain("ssh -T git@github-work");
	});

	it("attributes each host's verdict only to its own repos", () => {
		const byHost = new Map<string, GitIdentityProbe | null>([
			["github-personal", probe({ host: "github-personal" })],
			["github-work", probe({ host: "github-work", identity: "org/one", isDeployKey: true })],
		]);
		const issues = sshIdentityIssues(
			[
				{ host: "github-personal", repos: ["platform"] },
				{ host: "github-work", repos: ["api"] },
			],
			byHost,
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain('"api"');
		expect(issues[0].message).not.toContain('"platform"');
	});

	it("says NOTHING for a host it did not measure — unverified is not a finding", () => {
		// An older runner, a network hiccup, or a host past MAX_SSH_HOSTS. Manufacturing a warning
		// from an absent measurement is how the previous version produced its false positive.
		for (const entry of [undefined, null, { checked: undefined } as GitIdentityProbe]) {
			const byHost = new Map<string, GitIdentityProbe | null>(entry === undefined ? [] : [["github-personal", entry]]);
			expect(sshIdentityIssues(personal, byHost)).toEqual([]);
		}
	});

	it("stays silent on a healthy user account", () => {
		expect(sshIdentityIssues(personal, new Map([["github-personal", probe({ host: "github-personal" })]]))).toEqual([]);
	});

	it("caps the hosts a single call will probe", () => {
		expect(MAX_SSH_HOSTS).toBe(4);
	});
});

describe("both transports, reported together (#684's actual complaint)", () => {
	const onWork = [{ host: "github-work", repos: ["api"] }];
	const probed = (over: Partial<GitIdentityProbe>) =>
		new Map<string, GitIdentityProbe | null>([["github-work", { checked: true, host: "github-work", ...over }]]);

	it("reads the gh login only from a real answer", () => {
		expect(httpsLoginFrom({ checked: true, login: "serge-ivo" })).toBe("serge-ivo");
		// An older runner, an empty login, or an error is NOT a login — treating any of them as one
		// would put a fabricated account name into a remedy the owner is asked to act on.
		expect(httpsLoginFrom({ login: "serge-ivo" })).toBeNull();
		expect(httpsLoginFrom({ checked: true, login: "   " })).toBeNull();
		expect(httpsLoginFrom({ checked: true, error: "gh: not authenticated" })).toBeNull();
		expect(httpsLoginFrom(null)).toBeNull();
	});

	it("reports two identities as INFO, not a warning — the alias setup is deliberate", () => {
		// Routing two accounts through two ~/.ssh/config aliases necessarily disagrees with the one
		// `gh` login. Warning about it would be the false-positive class this module removed, one
		// layer up. `info` is excluded from summary.issueCount.
		const [issue] = sshIdentityIssues(onWork, probed({ identity: "work-bot", isDeployKey: false }), "serge-ivo");
		expect(issue.severity).toBe("info");
		expect(issue.message).toContain("SSH to github-work authenticates as work-bot");
		expect(issue.message).toContain("HTTPS (`gh`) authenticates as serge-ivo");
		expect(issue.fix).toContain("If that is deliberate");
	});

	it("says nothing when the two transports agree", () => {
		expect(sshIdentityIssues(onWork, probed({ identity: "serge-ivo", isDeployKey: false }), "serge-ivo")).toEqual([]);
		// Case is not identity: GitHub logins are case-insensitive.
		expect(sshIdentityIssues(onWork, probed({ identity: "Serge-Ivo", isDeployKey: false }), "serge-ivo")).toEqual([]);
	});

	it("says nothing about a difference it could not measure", () => {
		expect(sshIdentityIssues(onWork, probed({ identity: "work-bot", isDeployKey: false }), null)).toEqual([]);
	});

	it("names the HTTPS account in the deploy-key remedy — the fix #684 watched succeed", () => {
		// The issue's own observation: `gh repo clone` over HTTPS cloned the repo SSH had just
		// refused. Naming the account turns generic advice into that remedy.
		const [issue] = sshIdentityIssues(onWork, probed({ identity: "jobsearch-works/shared", isDeployKey: true }), "serge-ivo");
		expect(issue.severity).toBe("warn");
		expect(issue.fix).toContain("authenticates as serge-ivo on this machine");
	});

	it("falls back to generic advice when no gh login was established", () => {
		const [issue] = sshIdentityIssues(onWork, probed({ identity: "jobsearch-works/shared", isDeployKey: true }), null);
		expect(issue.fix).toContain("so the platform can inject a token");
		expect(issue.fix).not.toContain("authenticates as");
	});

	it("treats a slash as a deploy key even from a runner that omits the flag", () => {
		// The flag is the runner's; the slash is what it derives it from. A runner reporting the
		// identity but not the flag must not be read as a healthy user account.
		const [issue] = sshIdentityIssues(onWork, probed({ identity: "org/repo" }), "serge-ivo");
		expect(issue.severity).toBe("warn");
		expect(issue.message).toContain("is a deploy key");
	});
});
