import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiPathSegment,
	buildRuntimeRegistrationBody,
	buildRunnerArgs,
	createRunnerCommand,
	pagsApiBase,
	pagsHeaders,
	requestPags,
	requestRunner,
	runnerBaseUrl,
	runnerHeaders,
	runnerRequestHeaders,
} from "./runner.js";

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
