import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { engineSpawnEnv, writeGuardReport } from "./engine-env.js";
import { gitGuardRoot } from "./git-guard.js";
import { PUSH_GUARD_GAPS, PUSH_REFUSED_MARKER, pushGuardEnv, pushGuardRoot } from "./push-guard.js";

/**
 * #1252, on temporary repositories only. Real git pushes over the ssh transport into local bare
 * repositories: "ssh" here is a script that runs the remote command git hands it in a local directory
 * named like the GitHub repository — so what is exercised is git's own transport, and the GENERATED
 * wrapper that sits in it.
 */
const tmp = mkdtempSync(join(tmpdir(), "pags-pushguard-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SCOPE = ["proappstore-online/template-app"];
const BASE_ENV: NodeJS.ProcessEnv = {
	...process.env,
	PATH: (process.env.PATH ?? "")
		.split(":")
		.filter((d) => !d.startsWith(gitGuardRoot()) && !d.startsWith(pushGuardRoot()))
		.join(":"),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
delete BASE_ENV.GIT_SSH_COMMAND;
delete BASE_ENV.GIT_SSH;
delete BASE_ENV.GIT_CONFIG_COUNT;

let n = 0;
let dir: string;
let remotes: string;
let work: string;
let env: NodeJS.ProcessEnv;

/** A fake ssh: run `git-receive-pack '<owner>/<repo>.git'` (or upload-pack) against `$remotes/<owner>/<repo>.git`. */
function fakeSsh(): string {
	const path = join(dir, "fake-ssh");
	writeFileSync(path, `#!/bin/sh\nfor last in "$@"; do :; done\ncd ${JSON.stringify(remotes)} && eval "git \${last#git-}"\n`, { mode: 0o755 });
	return path;
}

const run = (args: string[], cwd = work, e = env) => spawnSync("git", args, { cwd, env: e, encoding: "utf8" });
const bare = (slug: string) => {
	const path = join(remotes, `${slug}.git`);
	mkdirSync(path, { recursive: true });
	spawnSync("git", ["init", "-q", "--bare", path], { env: BASE_ENV });
	return path;
};
const head = (path: string, ref = "refs/heads/main") => spawnSync("git", ["--git-dir", path, "rev-parse", "--verify", "-q", ref], { env: BASE_ENV, encoding: "utf8" }).stdout.trim();

beforeEach(() => {
	dir = join(tmp, `t${n++}`);
	remotes = join(dir, "remotes");
	work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	env = pushGuardEnv({ ...BASE_ENV, GIT_SSH_COMMAND: fakeSsh() }, SCOPE, join(dir, "guard"));
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: work, env: BASE_ENV });
	writeFileSync(join(work, "a.txt"), "a\n");
	spawnSync("git", ["add", "."], { cwd: work, env: BASE_ENV });
	spawnSync("git", ["commit", "-qm", "a"], { cwd: work, env: BASE_ENV });
});

describe("git push over ssh (#1252)", () => {
	it("a push to a REGISTERED repository goes through, through the machine's own ssh", () => {
		const allowed = bare("proappstore-online/template-app");
		const r = run(["push", "git@github-personal:proappstore-online/template-app.git", "main"]);
		expect(r.status, r.stderr).toBe(0);
		expect(head(allowed)).toBe(run(["rev-parse", "HEAD"]).stdout.trim());
	});

	it("a push to an UNREGISTERED repository is refused before anything is sent, naming the repository", () => {
		const other = bare("proappstore-online/tennis-clubs");
		const r = run(["push", "git@github-personal:proappstore-online/tennis-clubs.git", "main"]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proappstore-online/tennis-clubs`);
		expect(head(other)).toBe("");
	});

	it("a TAG push to an unregistered repository is refused (the runner-router `v1` move)", () => {
		const other = bare("ProAgentStore/runner-router"); // the same case as the URL: CI's filesystem is case-sensitive
		run(["tag", "v1"]);
		const r = run(["push", "git@github.com:ProAgentStore/runner-router.git", "v1"]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proagentstore/runner-router`);
		expect(head(other, "refs/tags/v1")).toBe("");
	});

	it("force, --no-verify, a named remote, and git by absolute path are all the same transport — all refused", () => {
		const other = bare("proappstore-online/tennis-clubs");
		run(["remote", "add", "origin", "ssh://git@github.com/proappstore-online/tennis-clubs.git"]);
		const realGit = spawnSync("sh", ["-c", "command -v git"], { env: BASE_ENV, encoding: "utf8" }).stdout.trim();
		for (const args of [["push", "--force", "origin", "main"], ["push", "--no-verify", "origin", "main"], ["push", "--mirror", "origin"]]) {
			const r = spawnSync(realGit, args, { cwd: work, env, encoding: "utf8" });
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.stderr).toContain(PUSH_REFUSED_MARKER);
		}
		expect(head(other)).toBe("");
	});

	it("a temp-dir clone of another repository can be READ, but not pushed back (the /tmp/rr case)", () => {
		const other = bare("ProAgentStore/runner-router"); // the same case as the URL: CI's filesystem is case-sensitive
		spawnSync("git", ["push", "-q", other, "main"], { cwd: work, env: BASE_ENV });
		const before = head(other);
		const clone = join(dir, "rr");
		const c = run(["clone", "-q", "git@github-personal:ProAgentStore/runner-router.git", clone], dir);
		expect(c.status, c.stderr).toBe(0); // fetches are untouched
		writeFileSync(join(clone, "b.txt"), "b\n");
		run(["add", "."], clone, BASE_ENV);
		run(["commit", "-qm", "b"], clone, BASE_ENV);
		const r = run(["push", "origin", "HEAD:main"], clone);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proagentstore/runner-router`);
		expect(head(other)).toBe(before);
	});
});

describe("git push over https (#1252)", () => {
	let helperDir: string;
	let calls: string;
	beforeEach(() => {
		// git's own https transport, stood in for: it records how it was invoked and fails, so no
		// network is touched. Only reached for an in-scope push.
		helperDir = join(dir, "libexec");
		calls = join(dir, "https-calls");
		mkdirSync(helperDir);
		writeFileSync(join(helperDir, "git-remote-https"), `#!/bin/sh\necho "$1 $2" >> ${JSON.stringify(calls)}\nexit 1\n`, { mode: 0o755 });
		env = pushGuardEnv(BASE_ENV, SCOPE, join(dir, "guard-https"), helperDir);
	});

	it("an unregistered repository is refused by the push helper, before git's https transport runs", () => {
		const r = run(["push", "https://github.com/proappstore-online/tennis-clubs.git", "main"]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proappstore-online/tennis-clubs`);
		expect(existsSync(calls)).toBe(false);
	});

	it("a registered repository is handed to git's own https transport, with the original URL", () => {
		const r = run(["push", "https://github.com/proappstore-online/template-app.git", "main"]);
		expect(r.stderr).not.toContain(PUSH_REFUSED_MARKER);
		expect(readFileSync(calls, "utf8").trim()).toBe("https://github.com/proappstore-online/template-app.git https://github.com/proappstore-online/template-app.git");
	});

	it("a lookalike name is not the registered repository", () => {
		const r = run(["push", "https://github.com/proappstore-online/template-app-evil.git", "main"]);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proappstore-online/template-app-evil`);
	});

	it("fetches are not rewritten", () => {
		expect(run(["config", "--get-urlmatch", "url.pags-push::https://github.com/.insteadof", "https://github.com/x/y"]).stdout).toBe("");
		expect(run(["ls-remote", "--get-url", "https://github.com/proappstore-online/tennis-clubs.git"]).stdout.trim()).toBe("https://github.com/proappstore-online/tennis-clubs.git");
	});
});

describe("the Engine's env (#1252)", () => {
	it("no registered repository, no guard — the env is untouched", () => {
		expect(pushGuardEnv(BASE_ENV, [], join(dir, "g"))).toBe(BASE_ENV);
		expect(pushGuardEnv(BASE_ENV, undefined, join(dir, "g"))).toBe(BASE_ENV);
	});

	it("config the machine already passes through GIT_CONFIG_COUNT is kept", () => {
		const e = pushGuardEnv({ ...BASE_ENV, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "kept" }, SCOPE, join(dir, "g2"), dir);
		expect(e).toMatchObject({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "kept", GIT_CONFIG_KEY_1: "url.pags-push::https://github.com/.pushInsteadOf" });
	});

	it("the session's guard report names the push guard's gaps, so coding_diagnostics cannot overstate it", () => {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const report = writeGuardReport(SCOPE, { PATH: bin }, join(dir, "gh-root"));
		expect(report.installed).toBe(true);
		expect(report.gaps).toEqual(expect.arrayContaining([...PUSH_GUARD_GAPS]));
		expect(report.gaps.join(" ")).not.toContain("`git push` is not gated");
	});

	it("every Engine spawn with a scope carries the push guard", () => {
		const e = engineSpawnEnv(undefined, SCOPE, join(dir, "gh"), join(dir, "git"), join(dir, "push-guard"));
		expect(e.GIT_SSH_COMMAND).toContain("push-guard");
		expect(e.GIT_CONFIG_COUNT).toBeDefined();
	});
});
