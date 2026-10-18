import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSecretFile as readAt, SECRET_MAX_BYTES, secureFilesDir, writeSecretFile as writeAt } from "./secret-file.js";

const SECRET = "FIREBASE_API_KEY=AIza-very-secret-value\nSERVER_KEY=s3cr3t\n";

/** A home of its own, so the dedicated folder (#1165) is a scratch one and the real `~` is never touched. */
const HOME = mkdtempSync(join(tmpdir(), "pags-secret-home-"));
const readSecretFile = (input: Parameters<typeof readAt>[0]) => readAt(input, HOME);
const writeSecretFile = (input: Parameters<typeof writeAt>[0]) => writeAt(input, HOME);

const roots: string[] = [HOME];
function scratch(): string {
	mkdirSync(secureFilesDir(HOME), { recursive: true });
	return mkdtempSync(join(secureFilesDir(HOME), "pags-secret-"));
}
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Every message a caller could see — none may carry the value. */
function errorOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	throw new Error("expected a throw");
}

describe("readSecretFile (#918)", () => {
	it("returns the exact bytes of a text file and its size", () => {
		const d = scratch();
		writeFileSync(join(d, ".env.prod"), SECRET);
		expect(readSecretFile({ path: join(d, ".env.prod") })).toEqual({ path: join(d, ".env.prod"), value: SECRET, bytes: Buffer.byteLength(SECRET) });
	});

	it("refuses missing, empty, directory, oversize and non-UTF-8 sources by path, never by content", () => {
		const d = scratch();
		expect(errorOf(() => readSecretFile({ path: join(d, "nope") }))).toMatch(/No file at/);
		writeFileSync(join(d, "empty"), "");
		expect(errorOf(() => readSecretFile({ path: join(d, "empty") }))).toMatch(/empty/);
		expect(errorOf(() => readSecretFile({ path: d }))).toMatch(/not a regular file/);
		writeFileSync(join(d, "big"), "x".repeat(SECRET_MAX_BYTES + 1));
		expect(errorOf(() => readSecretFile({ path: join(d, "big") }))).toMatch(/at most/);
		writeFileSync(join(d, "bin"), Buffer.from([0x53, 0x45, 0xff, 0xfe, 0x00]));
		const bin = errorOf(() => readSecretFile({ path: join(d, "bin") }));
		expect(bin).toMatch(/not UTF-8/);
		expect(errorOf(() => readSecretFile({}))).toMatch(/path/);
	});
});

describe("writeSecretFile (#918)", () => {
	it("writes the value with 0600 by default, creating parent dirs, and reports only a byte count", () => {
		const d = scratch();
		const target = join(d, "app", ".env.prod");
		const r = writeSecretFile({ path: target, value: SECRET });
		expect(r).toEqual({ path: target, bytes: Buffer.byteLength(SECRET), replaced: false });
		expect(JSON.stringify(r)).not.toContain("very-secret");
		expect(readFileSync(target, "utf8")).toBe(SECRET);
		expect(statSync(target).mode & 0o777).toBe(0o600);
		// The temp file is renamed away, not left beside the target.
		expect(readdirSync(join(d, "app"))).toEqual([".env.prod"]);
	});

	it("will not replace an existing file unless told to", () => {
		const d = scratch();
		const target = join(d, ".env.prod");
		writeFileSync(target, "OLD=1\n");
		expect(errorOf(() => writeSecretFile({ path: target, value: SECRET }))).toMatch(/already exists/);
		expect(readFileSync(target, "utf8")).toBe("OLD=1\n");
		expect(writeSecretFile({ path: target, value: SECRET, overwrite: true }).replaced).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(SECRET);
	});

	it("accepts a stricter or owner+group-readable mode, refuses a writable or executable one", () => {
		const d = scratch();
		writeSecretFile({ path: join(d, "a"), value: SECRET, mode: "640" });
		expect(statSync(join(d, "a")).mode & 0o777).toBe(0o640);
		expect(errorOf(() => writeSecretFile({ path: join(d, "b"), value: SECRET, mode: "666" }))).toMatch(/writable or executable/);
		expect(errorOf(() => writeSecretFile({ path: join(d, "c"), value: SECRET, mode: "700" }))).toMatch(/writable or executable/);
		expect(errorOf(() => writeSecretFile({ path: join(d, "d"), value: SECRET, mode: "200" }))).toMatch(/unreadable/);
		expect(errorOf(() => writeSecretFile({ path: join(d, "e"), value: SECRET, mode: "rw" }))).toMatch(/octal/);
	});

	it("refuses to write over a directory, and never echoes the value in any refusal", () => {
		const d = scratch();
		mkdirSync(join(d, "dir"));
		const messages = [
			errorOf(() => writeSecretFile({ path: join(d, "dir"), value: SECRET, overwrite: true })),
			errorOf(() => writeSecretFile({ path: join(d, "x"), value: SECRET, mode: "777" })),
			errorOf(() => writeSecretFile({ path: join(d, "x"), value: "" })),
		];
		for (const m of messages) expect(m).not.toContain("very-secret");
	});
});

describe("the secret handoff stays inside its own folder (#1165)", () => {
	function withKeys() {
		mkdirSync(join(HOME, ".ssh"), { recursive: true });
		writeFileSync(join(HOME, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n");
		writeFileSync(join(HOME, ".ssh", "authorized_keys"), "ssh-ed25519 AAAA owner@laptop\n");
	}

	it("will not read a private key — by absolute path, by ~/…, or by climbing out", () => {
		withKeys();
		for (const path of [join(HOME, ".ssh", "id_ed25519"), "~/.ssh/id_ed25519", "../../.ssh/id_ed25519"]) {
			const msg = errorOf(() => readSecretFile({ path }));
			expect(msg, path).toMatch(/outside/);
			expect(msg, path).not.toContain("PRIVATE KEY");
		}
	});

	it("will not replace ~/.ssh/authorized_keys, even with overwrite: true", () => {
		withKeys();
		for (const path of [join(HOME, ".ssh", "authorized_keys"), "~/.ssh/authorized_keys", "../../.ssh/authorized_keys"]) {
			expect(errorOf(() => writeSecretFile({ path, value: "ssh-ed25519 ATTACKER\n", overwrite: true })), path).toMatch(/outside/);
		}
		expect(readFileSync(join(HOME, ".ssh", "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAA owner@laptop\n");
	});

	it("a symlink planted in the folder cannot point back out — neither a link to a file nor to a folder", () => {
		withKeys();
		const root = secureFilesDir(HOME);
		mkdirSync(root, { recursive: true });
		symlinkSync(join(HOME, ".ssh", "id_ed25519"), join(root, "innocent.env"));
		expect(errorOf(() => readSecretFile({ path: "innocent.env" }))).toMatch(/outside|symbolic link/);
		symlinkSync(join(HOME, ".ssh"), join(root, "keys"));
		expect(errorOf(() => writeSecretFile({ path: "keys/authorized_keys", value: "ssh-ed25519 ATTACKER\n", overwrite: true }))).toMatch(/outside/);
		expect(readFileSync(join(HOME, ".ssh", "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAA owner@laptop\n");
	});

	it("a relative path lands in the folder, and reads back from there", () => {
		const r = writeSecretFile({ path: "heartfull/.env.prod", value: SECRET });
		expect(r.path).toBe(join(secureFilesDir(HOME), "heartfull", ".env.prod"));
		expect(readSecretFile({ path: "heartfull/.env.prod" }).value).toBe(SECRET);
	});
});
