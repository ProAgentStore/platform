/**
 * #1166 — what leaves this machine from a terminal pane is redacted: credential-shaped text by the one
 * shared redactor (`maskSecrets`, which now catches a two-part PAGS session), and every value
 * `secure_input_inject` delivered, even where it wrapped across rows.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maskSecrets } from "../crash-reports.js";
import { startRunnerServer } from "../server.js";
import { forgetInjected, maskInjected, outgoing, redactPane, redactPanesOf, rememberInjected } from "./pane-redact.js";

/** The real shape (workers/api/src/lib/session.ts): base64url(JSON payload) "." base64url(HMAC). Two segments. */
const PAGS_SESSION = `${Buffer.from(JSON.stringify({ uid: "github:serge-ivo", roles: ["user"], iat: 1, exp: 2 })).toString("base64url")}.${"x".repeat(43)}`;

afterEach(() => forgetInjected());

describe("the shared redactor catches a bare PAGS session (#1166)", () => {
	it("two segments, with nothing in front of it — the shape the old three-segment rule missed", () => {
		expect(maskSecrets(`session printed by a tool: ${PAGS_SESSION}`)).toBe("session printed by a tool: [redacted-jwt]");
	});

	it("still masks a three-part JWT, and leaves ordinary text alone", () => {
		expect(maskSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("[redacted-jwt]");
		expect(maskSecrets("npm run build && git status")).toBe("npm run build && git status");
	});
});

describe("a delivered value is masked in every later capture (#1166)", () => {
	const CODE = "4/0AVG7fiQ-VERIFICATION-CODE-7f3a";

	it("found on one row, or wrapped across two, and replaced character for character", () => {
		rememberInjected(CODE);
		expect(maskInjected(`Enter the code: ${CODE}\n$ `)).toBe(`Enter the code: ${"•".repeat(CODE.length)}\n$ `);
		const wrapped = `Enter the code: 4/0AVG7fiQ-VERIF\nICATION-CODE-7f3a\nYou are now logged in.`;
		const masked = maskInjected(wrapped);
		expect(masked).not.toContain("VERIF");
		expect(masked.split("\n")).toHaveLength(3);
		expect(masked.endsWith("You are now logged in.")).toBe(true);
	});

	it("is forgotten after its window", () => {
		rememberInjected(CODE, 0);
		expect(maskInjected(CODE, 25 * 60 * 60_000)).toBe(CODE);
	});

	it("a pane leaving a terminal route is redacted both ways; inject's own read (`unmasked`) is not", () => {
		rememberInjected(CODE);
		const pane = `$ echo ${PAGS_SESSION}\n${CODE}`;
		const res = {} as ServerResponse;
		redactPanesOf(res, "/tmux/capture", {});
		const out = outgoing(res, { session: "main", pane, paneBefore: pane, changed: false }) as { pane: string; paneBefore: string; changed: boolean };
		expect(out.pane).toBe(redactPane(pane));
		expect(out.pane).not.toContain(CODE);
		expect(out.pane).not.toContain(PAGS_SESSION);
		expect(out.paneBefore).toBe(out.pane);
		expect(out.changed).toBe(false);
		const raw = {} as ServerResponse;
		redactPanesOf(raw, "/tmux/capture", { unmasked: true });
		expect((outgoing(raw, { pane }) as { pane: string }).pane).toBe(pane);
		// Not a pane route at all: untouched.
		const other = {} as ServerResponse;
		redactPanesOf(other, "/health", {});
		expect((outgoing(other, { pane }) as { pane: string }).pane).toBe(pane);
	});

	it("so is a coding session's capture, which #1166 left out (#1195) — whatever the body asks", () => {
		rememberInjected(CODE);
		const pane = `engine output\n$ echo ${PAGS_SESSION}\nthe code was ${CODE}`;
		for (const path of ["/coding/capture", "/coding/diagnostics", "/coding/start"]) {
			const res = {} as ServerResponse;
			redactPanesOf(res, path, { unmasked: true }); // there is no unmasked read for the coding routes
			const out = outgoing(res, { sessionId: "s1", pane, paneBefore: pane, runState: "working" }) as { pane: string; paneBefore: string; runState: string };
			expect(out.pane, path).toBe(redactPane(pane));
			expect(out.pane, path).not.toContain(PAGS_SESSION);
			expect(out.pane, path).not.toContain(CODE);
			expect(out.paneBefore, path).toBe(out.pane);
			expect(out.runState, path).toBe("working");
		}
	});
});

describe("POST /secure/scrub (#1166)", () => {
	it("remembers the value for masking; a backend whose history it cannot reach says so", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-scrub-"));
		const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "secret", headless: true });
		started.runner.siteBuilder.launch = () => undefined;
		try {
			const res = await fetch(`${started.url}/secure/scrub`, {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ target: "kitty:3", value: "s3cret-passphrase" }),
			});
			expect(await res.json()).toEqual({ remembered: true, cleared: false });
			expect(redactPane("typed: s3cret-passphrase")).toBe(`typed: ${"•".repeat("s3cret-passphrase".length)}`);
		} finally {
			await started.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
