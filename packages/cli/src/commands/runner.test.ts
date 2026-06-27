import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiPathSegment,
	buildCloudflaredArgs,
	buildRuntimeRegistrationBody,
	buildRunnerArgs,
	cloudflaredAssetForPlatform,
	cloudflaredDownloadUrl,
	createRunnerCommand,
	extractCloudflaredBinary,
	pagsApiBase,
	pagsHeaders,
	parseCloudflaredTunnelUrl,
	requestPags,
	requestRunner,
	runnerBaseUrl,
	runnerHeaders,
	runnerRequestHeaders,
} from "./runner.js";

// No saved session in tests, so requestPags's session-token fallback resolves to none.
vi.mock("./login.js", () => ({ loadSession: () => null }));

describe("runner command helpers", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("builds runner process args", () => {
		expect(
			buildRunnerArgs({
				host: "127.0.0.1",
				port: "49171",
				token: "secret",
				instanceId: "inst-1",
				headless: true,
			}),
		).toEqual([
			"--host",
			"127.0.0.1",
			"--port",
			"49171",
			"--token",
			"secret",
			"--instance-id",
			"inst-1",
			"--headless",
		]);
	});

	it("builds cloudflared quick tunnel args", () => {
		expect(buildCloudflaredArgs("http://127.0.0.1:49171")).toEqual([
			"tunnel",
			"--url",
			"http://127.0.0.1:49171",
		]);
	});

	it("selects cloudflared release assets for supported npm platforms", () => {
		expect(cloudflaredAssetForPlatform("darwin", "arm64")).toEqual({
			asset: "cloudflared-darwin-arm64.tgz",
			executableName: "cloudflared",
			archive: true,
		});
		expect(cloudflaredAssetForPlatform("darwin", "x64")).toMatchObject({
			asset: "cloudflared-darwin-amd64.tgz",
			archive: true,
		});
		expect(cloudflaredAssetForPlatform("linux", "x64")).toMatchObject({
			asset: "cloudflared-linux-amd64",
			archive: false,
		});
		expect(cloudflaredAssetForPlatform("win32", "x64")).toMatchObject({
			asset: "cloudflared-windows-amd64.exe",
			executableName: "cloudflared.exe",
		});
		expect(() => cloudflaredAssetForPlatform("freebsd", "x64")).toThrow(
			"Automatic cloudflared download is not supported",
		);
	});

	it("builds the official cloudflared latest release download URL", () => {
		expect(cloudflaredDownloadUrl("cloudflared-darwin-arm64.tgz")).toBe(
			"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
		);
	});

	it("extracts the cloudflared binary from the macOS release archive", () => {
		const tgz = gzipSync(makeTar({ cloudflared: "binary-content" }));

		expect(
			extractCloudflaredBinary(
				{
					asset: "cloudflared-darwin-arm64.tgz",
					executableName: "cloudflared",
					archive: true,
				},
				tgz,
			).toString("utf8"),
		).toBe("binary-content");
	});

	it("parses cloudflared quick tunnel URLs", () => {
		expect(parseCloudflaredTunnelUrl("Visit it at https://abc-def.trycloudflare.com")).toBe(
			"https://abc-def.trycloudflare.com",
		);
		expect(parseCloudflaredTunnelUrl("no tunnel yet")).toBeNull();
		// cloudflared's own API host must never be picked as the tunnel URL.
		expect(parseCloudflaredTunnelUrl("Requesting new quick Tunnel on api.trycloudflare.com...")).toBeNull();
		expect(
			parseCloudflaredTunnelUrl("conn to api.trycloudflare.com | tunnel https://wise-owl-9.trycloudflare.com ready"),
		).toBe("https://wise-owl-9.trycloudflare.com");
	});

	it("normalizes runner URL", () => {
		expect(runnerBaseUrl("http://127.0.0.1:49171/")).toBe("http://127.0.0.1:49171");
		expect(runnerBaseUrl("   ")).toBe("http://127.0.0.1:49171");
	});

	it("normalizes PAGS API URL", () => {
		expect(pagsApiBase("https://api.proagentstore.online/")).toBe(
			"https://api.proagentstore.online",
		);
	});

	it("creates bearer headers when token is present", () => {
		expect(runnerHeaders("abc")).toEqual({ Authorization: "Bearer abc" });
		expect(pagsHeaders("pags")).toEqual({ Authorization: "Bearer pags" });
	});

	it("creates instance-bound request headers", () => {
		expect(runnerRequestHeaders({ token: "abc", instanceId: "inst-1" })).toEqual({
			Authorization: "Bearer abc",
			"X-PAGS-Instance-Id": "inst-1",
		});
	});

	it("encodes API path segments", () => {
		expect(apiPathSegment("inst/1")).toBe("inst%2F1");
	});

	it("builds PAGS runtime registration body", () => {
		expect(
			buildRuntimeRegistrationBody(
				{
					endpointUrl: " https://runner.example.com ",
					runnerToken: " runner-secret ",
					placement: "managed",
					runnerVersion: " 0.1.0 ",
				},
				["browser.playwright"],
			),
		).toEqual({
			endpointUrl: "https://runner.example.com",
			token: "runner-secret",
			placement: "managed",
			capabilities: ["browser.playwright"],
			runnerVersion: "0.1.0",
			runnerNode: expect.any(String),
		});
	});

	it("requires a PAGS token for PAGS API requests", async () => {
		await expect(requestPags("GET", "/v1/instances/inst-1/runtime", {})).rejects.toThrow(
			"PAGS token required",
		);
	});

	it("returns readable errors for non-JSON runner responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("runner is down", { status: 503, statusText: "Unavailable" })),
		);

		await expect(requestRunner("GET", "/health", {})).rejects.toThrow("503 runner is down");
	});

	it("sends local cancel command to the encoded runner task path", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				id: "task/1",
				status: "cancelled",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = createRunnerCommand();
		await command.parseAsync([
			"node",
			"runner",
			"cancel",
			"task/1",
			"--url",
			"http://127.0.0.1:49171",
			"--token",
			"runner-token",
			"--instance-id",
			"inst-1",
		]);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:49171/tasks/task%2F1/cancel",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer runner-token",
					"X-PAGS-Instance-Id": "inst-1",
				}),
			}),
		);
		expect(writeSpy).toHaveBeenCalled();
	});

	it("sends PAGS approve-task command to encoded instance and task paths", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				id: "task/1",
				status: "completed",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = createRunnerCommand();
		await command.parseAsync([
			"node",
			"runner",
			"approve-task",
			"inst/1",
			"task/1",
			"--api-base",
			"https://api.example.com/",
			"--pags-token",
			"pags-token",
		]);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.example.com/v1/instances/inst%2F1/tasks/task%2F1/approve",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer pags-token",
				}),
			}),
		);
		expect(writeSpy).toHaveBeenCalled();
	});
});

function makeTar(files: Record<string, string>): Buffer {
	const chunks: Buffer[] = [];
	for (const [name, content] of Object.entries(files)) {
		const body = Buffer.from(content);
		const header = Buffer.alloc(512);
		header.write(name, 0, "utf8");
		header.write("0000777\0", 100, "ascii");
		header.write("0000000\0", 108, "ascii");
		header.write("0000000\0", 116, "ascii");
		header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		header.write("00000000000\0", 136, "ascii");
		header.fill(" ", 148, 156);
		header.write("0", 156, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
		chunks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}
