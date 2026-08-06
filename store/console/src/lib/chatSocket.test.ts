import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("@proagentstore/sdk/client", () => ({
	API: "https://api.proagentstore.online",
	api: (...args: unknown[]) => apiMock(...args),
}));

const { chatSocketUrl, openAgentChatSocket } = await import("./chatSocket");

describe("chatSocketUrl", () => {
	it("upgrades the scheme and carries the supplied token", () => {
		const url = chatSocketUrl("https://api.proagentstore.online", "a1", "chat-tok");
		expect(url).toBe("wss://api.proagentstore.online/v1/agents/a1/ws?token=chat-tok");
	});

	it("uses ws:// against a local http API", () => {
		expect(chatSocketUrl("http://localhost:8787", "a1", "t")).toMatch(/^ws:\/\/localhost:8787\//);
	});

	it("escapes an agent id so it cannot inject query params", () => {
		const url = chatSocketUrl("https://api.example", "a1?token=stolen&x=", "t");
		expect(new URL(url).pathname).toBe("/v1/agents/a1%3Ftoken%3Dstolen%26x%3D/ws");
		expect(new URL(url).searchParams.get("token")).toBe("t");
	});
});

describe("openAgentChatSocket", () => {
	const sockets: string[] = [];
	beforeEach(() => {
		sockets.length = 0;
		apiMock.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for the DOM constructor
		(globalThis as any).WebSocket = class {
			constructor(url: string) { sockets.push(url); }
		};
	});

	it("mints a token first, then opens the socket with it", async () => {
		apiMock.mockResolvedValue({ token: "chat-tok", expiresAt: "2026-01-01T00:00:00Z" });
		await openAgentChatSocket("a1");
		expect(apiMock).toHaveBeenCalledWith("/v1/agents/a1/ws-token", { method: "POST" });
		expect(sockets).toEqual(["wss://api.proagentstore.online/v1/agents/a1/ws?token=chat-tok"]);
	});

	// The whole point of #317: the 30-day account session is what USED to sit here. It now
	// travels only in the mint call's Authorization header, which `api()` owns.
	it("puts no account session in the URL — only the minted token", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: node has no localStorage; stub the store api() reads
		(globalThis as any).localStorage = { getItem: () => "ACCOUNT-JWT", setItem() {}, removeItem() {} };
		apiMock.mockResolvedValue({ token: "chat-tok" });
		await openAgentChatSocket("a1");
		expect(sockets[0]).not.toContain("ACCOUNT-JWT");
	});

	it("mints again on every connect, so a reconnect never replays a stale token", async () => {
		apiMock.mockResolvedValueOnce({ token: "first" }).mockResolvedValueOnce({ token: "second" });
		await openAgentChatSocket("a1");
		await openAgentChatSocket("a1");
		expect(apiMock).toHaveBeenCalledTimes(2);
		expect(sockets.map((u) => new URL(u).searchParams.get("token"))).toEqual(["first", "second"]);
	});
});
