/**
 * #1296 — `runner connect` (what `pags up` runs) picks its own port unless told one. Its real Commander definition is parsed
 * and a real listener occupies the default port, so this tests the behaviour, not the source text.
 */
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerCommand } from "./command.js";
import { DEFAULT_RUNNER_PORT, selectConnectPort } from "./process.js";

const held: Server[] = [];
afterEach(() => {
	for (const s of held.splice(0)) s.close();
});

/** Make sure something is listening on the port: take it if free, else it is already occupied, which is the point. */
function occupy(port: number): Promise<void> {
	return new Promise((resolve) => {
		const s = createServer();
		s.once("error", () => resolve());
		s.listen(port, "127.0.0.1", () => {
			held.push(s);
			resolve();
		});
	});
}

const free = (port: number) =>
	new Promise<boolean>((resolve) => {
		const s = createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});

function connectCommand() {
	const connect = createRunnerCommand().commands.find((c) => c.name() === "connect");
	if (!connect) throw new Error("runner connect is gone");
	return connect;
}

describe("runner connect's port (#1296)", () => {
	it("declares no default port, so an unset --port reaches the free-port selection", () => {
		const connect = connectCommand();
		expect(connect.options.find((o) => o.long === "--port")?.defaultValue).toBeUndefined();
		connect.parseOptions(["inst-1"]);
		expect(connect.opts().port).toBeUndefined();
	});

	it("with the default port occupied and no --port, the selected port is a different, free one", async () => {
		await occupy(DEFAULT_RUNNER_PORT);
		expect(await free(DEFAULT_RUNNER_PORT)).toBe(false);
		const connect = connectCommand();
		connect.parseOptions(["inst-1"]);
		const port = Number(await selectConnectPort(connect.opts().port));
		expect(port).toBeGreaterThan(DEFAULT_RUNNER_PORT);
		expect(await free(port)).toBe(true);
	});

	it("an explicit --port is honoured exactly, even when it is occupied — never moved quietly", async () => {
		await occupy(DEFAULT_RUNNER_PORT);
		const connect = connectCommand();
		connect.parseOptions(["inst-1", "--port", String(DEFAULT_RUNNER_PORT)]);
		expect(connect.opts().port).toBe(String(DEFAULT_RUNNER_PORT));
		expect(await selectConnectPort(connect.opts().port)).toBe(String(DEFAULT_RUNNER_PORT));
		expect(await selectConnectPort("50123")).toBe("50123");
	});

	it("with the default port free it is used", async () => {
		const seen: number[] = [];
		expect(await selectConnectPort(undefined, async (start) => {
			seen.push(start);
			return start;
		})).toBe(String(DEFAULT_RUNNER_PORT));
		expect(seen).toEqual([DEFAULT_RUNNER_PORT]);
		expect(await selectConnectPort("  ", async (s) => s)).toBe(String(DEFAULT_RUNNER_PORT));
	});
});
