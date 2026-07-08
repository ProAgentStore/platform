import { afterEach, describe, expect, it, vi } from "vitest";
import { listIssues, readIssue } from "./github-issues.js";
import type { Env } from "../types.js";

vi.mock("./github-app.js", () => ({
	installationTokenForOwner: vi.fn(async () => "tok_abc"),
}));

const env = {} as Env;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const { status, body } = handler(url, init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as Response;
	}) as unknown as typeof fetch;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listIssues", () => {
	it("filters out pull requests and maps fields", async () => {
		mockFetch(() => ({
			status: 200,
			body: [
				{ number: 5, title: "Real bug", state: "open", comments: 2, updated_at: "2026-07-01T00:00:00Z", html_url: "u5", labels: [{ name: "bug" }, "ui"] },
				{ number: 6, title: "A PR", state: "open", comments: 0, updated_at: "2026-07-02T00:00:00Z", html_url: "u6", pull_request: { url: "x" } },
			],
		}));
		const issues = await listIssues(env, "user1", "acme/widget");
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ number: 5, title: "Real bug", labels: ["bug", "ui"], comments: 2, url: "u5" });
	});

	it("hits the issues endpoint with the auth header", async () => {
		let seenUrl = "";
		let seenAuth: string | undefined;
		mockFetch((url, init) => {
			seenUrl = url;
			seenAuth = (init?.headers as Record<string, string>)?.Authorization;
			return { status: 200, body: [] };
		});
		await listIssues(env, "user1", "acme/widget");
		expect(seenUrl).toContain("https://api.github.com/repos/acme/widget/issues");
		expect(seenAuth).toBe("token tok_abc");
	});

	it("returns [] on a malformed repo (no owner/repo)", async () => {
		mockFetch(() => ({ status: 200, body: [] }));
		expect(await listIssues(env, "user1", "widget")).toEqual([]);
	});

	it("returns [] on a GitHub error", async () => {
		mockFetch(() => ({ status: 404, body: { message: "Not Found" } }));
		expect(await listIssues(env, "user1", "acme/widget")).toEqual([]);
	});

	it("returns [] when fetch throws", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await listIssues(env, "user1", "acme/widget")).toEqual([]);
	});
});

describe("readIssue", () => {
	it("returns the detail with a body", async () => {
		mockFetch(() => ({
			status: 200,
			body: { number: 5, title: "Real bug", state: "open", comments: 0, updated_at: "", html_url: "u5", body: "Steps to reproduce", labels: [] },
		}));
		const issue = await readIssue(env, "user1", "acme/widget", 5);
		expect(issue).toMatchObject({ number: 5, title: "Real bug", body: "Steps to reproduce" });
	});

	it("returns null when the item is a PR", async () => {
		mockFetch(() => ({
			status: 200,
			body: { number: 6, title: "A PR", pull_request: { url: "x" }, body: "", labels: [] },
		}));
		expect(await readIssue(env, "user1", "acme/widget", 6)).toBeNull();
	});

	it("returns null on a GitHub error", async () => {
		mockFetch(() => ({ status: 404, body: {} }));
		expect(await readIssue(env, "user1", "acme/widget", 99)).toBeNull();
	});
});
