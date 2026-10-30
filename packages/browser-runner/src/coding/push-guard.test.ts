import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { engineSpawnEnv, writeGuardReport } from "./engine-env.js";
import { gitGuardRoot } from "./git-guard.js";
import {
	PUSH_DELEGATE_TIMEOUT_SECONDS,
	PUSH_GUARD_GAPS,
	PUSH_REFUSED_MARKER,
	PUSH_TIMEOUT_MARKER,
	pushGuardEnv,
	pushGuardRoot,
	pushRewrites,
	renderPushHelper,
} from "./push-guard.js";

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

/**
 * #1403: `pags-push` ran until the Engine's own OUTER tool-call timeout killed it (rc=124, 60-120s,
 * no error output). The real transport has no bound of its own, so a stalled credential helper, DNS
 * lookup or TLS handshake just hangs. These push the registered repository through a REAL generated
 * guard (`pushGuardEnv`, not `renderPushHelper` directly) at a short timeout, standing in for
 * `git-remote-https` with fakes that hang, succeed and fail, so the three paths this closes are all
 * exercised through git's own transport, exactly like the sibling describe block above.
 */
describe("a stalled real transport is bounded, not silent (#1403)", () => {
	let helperDir: string;
	beforeEach(() => {
		helperDir = join(dir, "libexec-slow");
		mkdirSync(helperDir);
	});

	it("a delegate that never returns is killed at the configured bound, with a marker naming the repo and the real transport — not a bare rc=124", () => {
		writeFileSync(join(helperDir, "git-remote-https"), `#!/bin/sh\nsleep 300\n`, { mode: 0o755 });
		env = pushGuardEnv(BASE_ENV, SCOPE, join(dir, "guard-hang"), helperDir, 1);
		const started = Date.now();
		const r = run(["push", "https://github.com/proappstore-online/template-app.git", "main"]);
		expect(Date.now() - started).toBeLessThan(10_000); // bounded, not left to the Engine's own ~120s kill
		// Not PUSH_TIMEOUT_EXIT itself: git normalizes ANY remote-helper failure — ours included — to
		// its own generic 128, the same reason the sibling refusal test above checks `.not.toBe(0)`
		// rather than the exact value. The MARKER is the real contract (`write-scope-refusals.ts`
		// parses it; nothing reads the raw exit code), and the helper's own exit code IS verified at
		// the sh level by the manual timing checks this fix was validated against.
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`${PUSH_TIMEOUT_MARKER} proappstore-online/template-app did not complete within 1s`);
		expect(r.stderr).toContain("git-remote-https");
	});

	it("a delegate that answers before the bound finishes fast, with no timeout marker", () => {
		// Not a real `git-remote-https`: it never speaks the remote-helper protocol (capabilities,
		// list, push), so git reports its own generic failure however this fake is invoked — exec'd
		// directly or through this bound, which is WHY the bound exists to be proven here, not a
		// clean `git push` exit. What this guards: the bound must not fire just because a FAST,
		// genuinely-finished delegate happened to be running — the absence of the marker is the claim.
		writeFileSync(join(helperDir, "git-remote-https"), `#!/bin/sh\necho fine\nexit 0\n`, { mode: 0o755 });
		env = pushGuardEnv(BASE_ENV, SCOPE, join(dir, "guard-fast"), helperDir, 5);
		const started = Date.now();
		const r = run(["push", "https://github.com/proappstore-online/template-app.git", "main"]);
		expect(Date.now() - started).toBeLessThan(5_000); // well under the 5s bound — it never had to wait
		expect(r.stderr).not.toContain(PUSH_TIMEOUT_MARKER);
	});

	it("a delegate that fails fast (git's own reason) is unaffected by the bound — only a HANG is a timeout", () => {
		writeFileSync(join(helperDir, "git-remote-https"), `#!/bin/sh\necho "fatal: could not read Username" >&2\nexit 128\n`, { mode: 0o755 });
		env = pushGuardEnv(BASE_ENV, SCOPE, join(dir, "guard-failfast"), helperDir, 5);
		const r = run(["push", "https://github.com/proappstore-online/template-app.git", "main"]);
		expect(r.status).toBe(128);
		expect(r.stderr).toContain("could not read Username");
		expect(r.stderr).not.toContain(PUSH_TIMEOUT_MARKER);
	});

	it("an out-of-scope repository is still refused immediately — the bound never even starts the delegate", () => {
		writeFileSync(join(helperDir, "git-remote-https"), `#!/bin/sh\nsleep 300\n`, { mode: 0o755 });
		env = pushGuardEnv(BASE_ENV, SCOPE, join(dir, "guard-hang-oos"), helperDir, 1);
		const started = Date.now();
		const r = run(["push", "https://github.com/proappstore-online/tennis-clubs.git", "main"]);
		expect(Date.now() - started).toBeLessThan(5_000);
		// Not PUSH_REFUSED_EXIT itself: git does not pass a remote helper's raw exit code through when
		// the helper dies before ever answering its protocol (it reports its own "connection died"
		// code instead) — the same reason the sibling refusal tests above check `.not.toBe(0)` rather
		// than the exact value. The constant IS still what the helper itself exits with; see the
		// `renderPushHelper` string-level tests and the #1403 timeout tests, which run late enough in
		// git's protocol exchange for the real code to come through.
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(PUSH_REFUSED_MARKER);
	});

	it("defaults to PUSH_DELEGATE_TIMEOUT_SECONDS, comfortably under the Engine's outer tool-call bound", () => {
		expect(renderPushHelper({ scope: SCOPE, realHelperDir: "/x" })).toContain(`-ge ${PUSH_DELEGATE_TIMEOUT_SECONDS} ]`);
		expect(PUSH_DELEGATE_TIMEOUT_SECONDS).toBeLessThan(60);
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

describe("the owner's own url rewrites survive the push guard (Grass Karma #33)", () => {
	it("an https remote the owner rewrites to an ssh alias still pushes over ssh — not onto credential-less https", () => {
		const allowed = bare("proappstore-online/template-app");
		const cfg = join(dir, "gitconfig");
		writeFileSync(cfg, '[url "git@github-personal:"]\n\tinsteadOf = https://github.com/\n');
		const machine = { ...BASE_ENV, GIT_CONFIG_GLOBAL: cfg, GIT_SSH_COMMAND: fakeSsh() };
		const e = pushGuardEnv(machine, SCOPE, join(dir, "guard-alias"), join(dir, "no-https-here"));
		run(["remote", "add", "origin", "https://github.com/proappstore-online/template-app.git"]);
		const r = run(["push", "origin", "main"], work, e);
		expect(r.status, r.stderr).toBe(0);
		expect(head(allowed)).toBe(run(["rev-parse", "HEAD"]).stdout.trim());
	});

	it("over that alias an out-of-scope push is still refused, by the ssh wrapper", () => {
		const other = bare("proappstore-online/tennis-clubs");
		const cfg = join(dir, "gitconfig");
		writeFileSync(cfg, '[url "git@github-personal:"]\n\tinsteadOf = https://github.com/\n');
		const e = pushGuardEnv({ ...BASE_ENV, GIT_CONFIG_GLOBAL: cfg, GIT_SSH_COMMAND: fakeSsh() }, SCOPE, join(dir, "guard-alias2"), join(dir, "x"));
		const r = run(["push", "https://github.com/proappstore-online/tennis-clubs.git", "main"], work, e);
		expect(r.stderr).toContain(`${PUSH_REFUSED_MARKER} git push to proappstore-online/tennis-clubs`);
		expect(head(other)).toBe("");
	});

	it("pushRewrites: no machine rule routes through the helper; a covering or narrower ssh rule is kept", () => {
		expect(pushRewrites([])).toEqual([["pags-push::https://github.com/", "https://github.com/"], ["pags-push::http://github.com/", "http://github.com/"]]);
		expect(pushRewrites([{ base: "git@gh:", value: "https://github.com/", push: false }])[0]).toEqual(["git@gh:", "https://github.com/"]);
		expect(pushRewrites([{ base: "ssh://git@gh/", value: "https://", push: false }])[0]).toEqual(["ssh://git@gh/github.com/", "https://github.com/"]);
		const narrow = pushRewrites([{ base: "git@work:", value: "https://github.com/acme/", push: false }]);
		expect(narrow).toContainEqual(["git@work:", "https://github.com/acme/"]);
		expect(narrow).toContainEqual(["pags-push::https://github.com/", "https://github.com/"]);
		// An https→https rewrite still goes through the helper, and a pushInsteadOf outranks insteadOf.
		expect(pushRewrites([{ base: "https://github.com/", value: "https://gh/", push: false }])[0][0]).toBe("pags-push::https://github.com/");
		expect(pushRewrites([{ base: "git@a:", value: "https://github.com/", push: false }, { base: "git@b:", value: "https://github.com/", push: true }])[0]).toEqual(["git@b:", "https://github.com/"]);
	});

	it("the https helper never waits on a terminal prompt", () => {
		// Not `exec` any more (#1403 bounds the delegate instead), but GIT_TERMINAL_PROMPT=0 must
		// still be set BEFORE the delegate call, which is what actually matters here.
		const script = renderPushHelper({ scope: SCOPE, realHelperDir: "/x" });
		const promptAt = script.indexOf("GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT");
		const delegateAt = script.indexOf('"$real" "$1" "$url"');
		expect(promptAt).toBeGreaterThan(-1);
		expect(delegateAt).toBeGreaterThan(promptAt);
	});
});
