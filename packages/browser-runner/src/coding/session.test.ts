import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CodingSession } from "./session.js";
import { GenericHandler, handlerFor } from "./handlers.js";
import { listSessions, sanitizeSessionName, stripAnsi } from "./tmux.js";

function tmuxAvailable(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const HAS_TMUX = tmuxAvailable();
const describeTmux = HAS_TMUX ? describe : describe.skip;

describe("coding handlers", () => {
	it("detects a shell prompt as ready", () => {
		const h = new GenericHandler();
		expect(h.isReady("user@host project %")).toBe(true);
		expect(h.isReady("$ ")).toBe(true);
		expect(h.isReady("running...")).toBe(false);
	});

	it("detects Claude busy vs ready", () => {
		const c = handlerFor("claude");
		expect(c.isReady("esc to interrupt · ctrl+c to interrupt")).toBe(false);
		expect(c.isReady("Some output\n❯ ")).toBe(true);
	});

	it("extracts the response after the echoed input", () => {
		const h = new GenericHandler();
		const pane = ["$ echo hello", "hello", "$ "].join("\n");
		expect(h.extractResponse(pane, "echo hello")).toBe("hello");
	});

	it("sanitizes session names", () => {
		expect(sanitizeSessionName("ProAgentStore/platform#main")).toBe("ProAgentStore-platform-main");
	});

	it("strips ANSI", () => {
		expect(stripAnsi("\x1B[31mred\x1B[0m")).toBe("red");
	});
});

describeTmux("CodingSession against a real tmux shell", () => {
	let workDir: string;
	const opened: CodingSession[] = [];

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "pags-coding-spike-"));
	});

	afterEach(() => {
		for (const s of opened.splice(0)) s.stop();
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	function open(id: string): CodingSession {
		const s = new CodingSession({ id, workDir, clientType: "generic" });
		opened.push(s);
		s.start();
		return s;
	}

	it("starts, runs a command, streams output, and reports the result", async () => {
		const s = open("spike-echo");
		expect(s.alive).toBe(true);
		expect(listSessions()).toContain(s.sessionName);

		const frames: string[] = [];
		const response = await s.send("echo hello-from-tmux", (content) => {
			frames.push(content);
		});

		expect(response).toContain("hello-from-tmux");
		// At least the final streamed frame should have fired.
		expect(frames.length).toBeGreaterThan(0);
	}, 20_000);

	it("injects BYOK env into the session", async () => {
		const s = new CodingSession({
			id: "spike-env",
			workDir,
			clientType: "generic",
			env: { PAGS_SPIKE_TOKEN: "sk-test-123" },
		});
		opened.push(s);
		s.start();

		const response = await s.send("echo key=$PAGS_SPIKE_TOKEN");
		expect(response).toContain("key=sk-test-123");
	}, 20_000);

	it("kills the session on stop()", () => {
		const s = open("spike-kill");
		const name = s.sessionName;
		expect(listSessions()).toContain(name);
		s.stop();
		expect(listSessions()).not.toContain(name);
	});
});
