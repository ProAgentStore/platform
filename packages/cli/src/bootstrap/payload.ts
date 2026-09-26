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
import { join } from "node:path";
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

/** The newest published CLI version, or null when npm could not be asked. */
export async function latestPublishedVersion(timeoutMs = 30_000): Promise<string | null> {
	try {
		const { stdout } = await run("npm", ["view", CLI_PACKAGE, "version"], { timeout: timeoutMs });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** Install `version`'s package tree into `dir` with npm. Rejects with npm's own reason. */
export async function npmInstallInto(dir: string, version: string): Promise<void> {
	try {
		await run("npm", ["install", "--prefix", dir, "--omit=dev", "--no-audit", "--no-fund", "--no-save", `${CLI_PACKAGE}@${version}`], { timeout: 5 * 60_000 });
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
