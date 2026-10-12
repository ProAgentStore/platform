/**
 * The payload cache behind the `pags` bootstrap stub (#862).
 *
 * `npm i -g @proagentstore/cli` installs a stub (`dist/bootstrap.js`) as the `pags` bin, beside the
 * CLI it was published with. Every newer release the stub fetches lands here, one folder per version
 * (`<root>/<version>/node_modules/@proagentstore/cli`), and the stub runs the newest one it has.
 *
 * Node builtins ONLY. The stub imports this and nothing else, so it keeps working however much the
 * CLI around it changes — the whole point is that it never needs reinstalling by hand.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CLI_PACKAGE = "@proagentstore/cli";
/** The stub sets this to its own path before it runs a payload; a payload reads it to know it is bootstrapped. */
export const BOOTSTRAP_ENV = "PAGS_BOOTSTRAP";
/** `1` turns the stub's check off — the machine stays on whatever it has. */
export const NO_SELF_UPDATE_ENV = "PAGS_NO_SELF_UPDATE";
/** Payload versions kept after an install: the new one and the one before it. */
const KEEP = 2;

/** Where fetched payloads live. `PAGS_CLI_CACHE` overrides it (tests, unusual homes). */
export function payloadRoot(): string {
	return process.env.PAGS_CLI_CACHE || join(homedir(), ".config", "proagentstore", "cli");
}

/** Whether `v` reads as a numeric `major.minor.patch` version — the only kind {@link olderThan} compares. */
export function isVersion(v: unknown): v is string {
	return typeof v === "string" && /^(\d+)\.(\d+)\.(\d+)/.test(v.trim());
}

/** Numeric semver compare, `a < b`. Anything unparseable is not "older" — never update on a guess. */
export function olderThan(a: string, b: string): boolean {
	const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
	return false;
}

export interface Payload {
	version: string;
	/** The CLI entry to import — the package's `pagsPayload` field, else `dist/index.js`. */
	entry: string;
}

/** The CLI package at `dir`, or null when it is not a complete one. */
export function payloadAt(dir: string): Payload | null {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: string; version?: string; pagsPayload?: string };
		if (pkg.name !== CLI_PACKAGE || !pkg.version) return null;
		const entry = join(dir, pkg.pagsPayload || "dist/index.js");
		return existsSync(entry) ? { version: pkg.version, entry } : null;
	} catch {
		return null;
	}
}

/** Where `npm install --prefix <prefix>` puts the CLI package. */
const installedAt = (prefix: string) => join(prefix, "node_modules", ...CLI_PACKAGE.split("/"));
const packageDir = (root: string, version: string) => installedAt(join(root, version));

/** Every complete payload in the cache. */
export function cachedPayloads(root: string = payloadRoot()): Payload[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	return names.flatMap((v) => (v.startsWith(".") ? [] : (payloadAt(packageDir(root, v)) ?? [])));
}

/** The newest of the payloads given — the first one on a tie, so the bundled payload wins against its own copy. */
export function newestPayload(payloads: Payload[]): Payload | null {
	return payloads.reduce<Payload | null>((best, p) => (!best || olderThan(best.version, p.version) ? p : best), null);
}

/** What `execFile` is given to run npm: the file, its arguments, and whether they are already quoted for cmd.exe. */
export interface NpmInvocation {
	file: string;
	args: string[];
	windowsVerbatimArguments?: true;
}

export interface NpmDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** The Node running this process — what runs npm's own script on Windows. */
	execPath?: string;
	exists?: (p: string) => boolean;
}

// cmd.exe metacharacters; a caret makes the next one literal for one parse (cross-spawn's set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /s /c "npm …"`: CRT-quoted, then caret-escaped for cmd and again for npm.cmd's `%*`. */
export function quoteCmdArg(arg: string): string {
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** Windows env names are case-insensitive; a copied env object is not (`Path`, `ComSpec`). */
const envVar = (env: NodeJS.ProcessEnv, name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];

/**
 * How to run npm here (#1020). Elsewhere `npm` is an executable and runs as itself.
 *
 * On Windows `npm` is `npm.cmd`, which `execFile` cannot start without a shell — so every npm call in
 * the update path failed, the release check came back empty, and an auto-update machine reported
 * `unsupported` ("npm could not be asked for the latest …", dell-laptop, 2026-10-12). So on win32:
 *
 *   1. npm's own `npm-cli.js`, run by this Node with no shell — found beside the `npm.cmd` that PATH
 *      resolves (what `npm` means in the owner's terminal, an upgraded global npm included), else
 *      beside node.exe, where the Node installer puts it;
 *   2. otherwise `npm.cmd` through `cmd.exe /d /s /c`, every argument quoted and caret-escaped
 *      (#1033: never an unquoted argument through a shell).
 */
export function npmInvocation(args: string[], deps: NpmDeps = {}): NpmInvocation {
	if ((deps.platform ?? process.platform) !== "win32") return { file: "npm", args };
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const execPath = deps.execPath ?? process.execPath;
	const cli = (dir: string) => win32.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
	const onPath = (envVar(env, "PATH") ?? "").split(";").filter((dir) => dir && exists(win32.join(dir, "npm.cmd")));
	for (const dir of [...onPath, win32.dirname(execPath)]) {
		if (exists(cli(dir))) return { file: execPath, args: [cli(dir), ...args] };
	}
	const line = ["npm", ...args.map(quoteCmdArg)].join(" ");
	return { file: envVar(env, "COMSPEC") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** `execFile` for npm, the right way for this platform. */
export function runNpm(args: string[], options: { timeout: number; signal?: AbortSignal }) {
	const npm = npmInvocation(args);
	return run(npm.file, npm.args, { ...options, ...(npm.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

/**
 * The newest published CLI version — or WHY npm could not say (#1054). The reason used to be dropped here, so a
 * Windows machine whose npm could not even be started reported only "npm could not be asked", with nothing to act on.
 * npm's own stderr when it ran and failed; the spawn error (ENOENT, EINVAL, a timeout) when it could not run at all.
 */
export async function latestPublishedRelease(timeoutMs = 30_000, signal?: AbortSignal, deps: { runNpm?: typeof runNpm } = {}): Promise<{ version: string } | { error: string }> {
	try {
		const { stdout } = await (deps.runNpm ?? runNpm)(["view", CLI_PACKAGE, "version"], { timeout: timeoutMs, signal });
		const version = String(stdout).trim();
		return version ? { version } : { error: "npm printed no version" };
	} catch (e) {
		return { error: npmFailure(e) };
	}
}

/** One line saying why an npm call failed: npm's last stderr line, else how it failed to run. Bounded, never multi-line. */
export function npmFailure(e: unknown): string {
	const err = e as { stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
	const stderr = String(err?.stderr ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const npmErrors = stderr.filter((l) => /npm (ERR!|error)/i.test(l));
	const why =
		npmErrors.slice(0, 2).join(" ") ||
		stderr.at(-1) ||
		(err?.killed || err?.signal ? `npm did not answer in time (${String(err.signal ?? "killed")})` : "") ||
		(typeof err?.code === "string" ? `npm could not be started (${err.code}: ${String(err.message ?? "")})` : "") ||
		String(err?.message ?? e);
	return why.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The newest published CLI version, or null when npm could not be asked. */
export async function latestPublishedVersion(timeoutMs = 30_000, signal?: AbortSignal): Promise<string | null> {
	const r = await latestPublishedRelease(timeoutMs, signal);
	return "version" in r ? r.version : null;
}

/** Install `version`'s package tree into `dir` with npm. Rejects with npm's own reason. */
export async function npmInstallInto(dir: string, version: string): Promise<void> {
	try {
		await runNpm(["install", "--prefix", dir, "--omit=dev", "--no-audit", "--no-fund", "--no-save", `${CLI_PACKAGE}@${version}`], { timeout: 5 * 60_000 });
	} catch (e) {
		const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error((stderr || (e instanceof Error ? e.message : String(e))).slice(-400));
	}
}

/**
 * Fetch `version` into the cache and answer it. Installed into a scratch folder and RENAMED into place,
 * so a crash or a second `pags up` doing the same never leaves a half-written payload for the stub to
 * run. Older versions beyond the last {@link KEEP} are removed.
 */
export async function installPayload(version: string, root: string = payloadRoot(), install = npmInstallInto): Promise<Payload> {
	const done = payloadAt(packageDir(root, version));
	if (done) return done;
	mkdirSync(root, { recursive: true });
	const scratch = mkdtempSync(join(root, `.install-${version}-`));
	try {
		await install(scratch, version);
		if (payloadAt(installedAt(scratch))?.version !== version) throw new Error(`npm installed no ${CLI_PACKAGE}@${version}`);
		try {
			renameSync(scratch, join(root, version));
		} catch (e) {
			// Another `pags up` got there first — its copy is as good as ours.
			if (!payloadAt(packageDir(root, version))) throw e;
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	const payload = payloadAt(packageDir(root, version));
	if (!payload) throw new Error(`${CLI_PACKAGE}@${version} is not usable after install`);
	for (const old of cachedPayloads(root).sort((a, b) => (olderThan(a.version, b.version) ? 1 : -1)).slice(KEEP)) {
		rmSync(join(root, old.version), { recursive: true, force: true });
	}
	return payload;
}
