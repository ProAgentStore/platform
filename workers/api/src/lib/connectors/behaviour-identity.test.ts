// Proves the #86 refactor is BEHAVIOUR-IDENTICAL: the github + meta tools now obtain
// auth via ctx.connectorClient(...) instead of importing token fns directly, but the
// SAME token source is used (installationTokenForOwner for github, META_ACCESS_TOKEN for
// meta), the SAME requests are made, and the SAME outputs come back.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";

vi.mock("../github-app.js", () => ({
	githubAppConfigured: () => true,
	installationTokenForOwner: vi.fn(),
}));

import { runRegistryTool } from "../tool-registry.js";
import { installationTokenForOwner } from "../github-app.js";

/** Env whose consent lookup returns write-consent for every (instance,connector). */
function envWithConsent(extra: Partial<Env> = {}): Env {
	return {
		DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }) }) },
		...extra,
	} as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("github tools stay behaviour-identical through connectorClient", () => {
	it("github_workflow_runs mints the owner's installation token and returns the same shape", async () => {
		vi.mocked(installationTokenForOwner).mockResolvedValue("gh-installation-token");
		const capturedAuth: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			capturedAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
			return new Response(JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: "success", head_branch: "main" }] }), { status: 200 });
		});

		const r = await runRegistryTool(
			"github_workflow_runs",
			{ env: envWithConsent(), userId: "u1", instanceId: "i1" },
			{ repo: "acme/widgets" },
		);
		expect(r.success).toBe(true);
		// Token minted for the repo owner — same as the old inline installationTokenForOwner(env, userId, owner).
		expect(installationTokenForOwner).toHaveBeenCalledWith(expect.anything(), "u1", "acme");
		// The GitHub REST calls use the classic `token <t>` header the tool already built.
		expect(capturedAuth[0]).toBe("token gh-installation-token");
		expect(JSON.parse(r.content)[0]).toMatchObject({ status: "completed", conclusion: "success", branch: "main" });
	});

	it("github_create_issue (write) still resolves the owner's token after the consent gate", async () => {
		vi.mocked(installationTokenForOwner).mockResolvedValue("gh-tok");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/issues/7" }), { status: 201 }),
		);
		const r = await runRegistryTool(
			"github_create_issue",
			{ env: envWithConsent(), userId: "u1", instanceId: "i1" },
			{ repo: "acme/widgets", title: "hi" },
		);
		expect(r.success).toBe(true);
		expect(r.content).toContain("Opened issue #7");
		expect(installationTokenForOwner).toHaveBeenCalledWith(expect.anything(), "u1", "acme");
	});
});

describe("meta tools stay behaviour-identical through connectorClient", () => {
	it("whatsapp_send_message uses the platform META_ACCESS_TOKEN as the Bearer, same request", async () => {
		let auth = "";
		let url = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
			url = String(u);
			auth = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
		});
		const env = envWithConsent({ META_ACCESS_TOKEN: "meta-business-token", WHATSAPP_PHONE_NUMBER_ID: "phone-1" });
		const r = await runRegistryTool(
			"whatsapp_send_message",
			{ env, userId: "u1", instanceId: "i1" },
			{ to: "+14155552671", text: "hello" },
		);
		expect(r.success).toBe(true);
		expect(auth).toBe("Bearer meta-business-token"); // same token source as the old ctx.env.META_ACCESS_TOKEN
		expect(url).toContain("/phone-1/messages");
	});

	it("meta tool with the env token unset → same 'not configured' result (no throw)", async () => {
		const env = envWithConsent({ WHATSAPP_PHONE_NUMBER_ID: "phone-1" }); // no META_ACCESS_TOKEN
		const r = await runRegistryTool(
			"whatsapp_send_message",
			{ env, userId: "u1", instanceId: "i1" },
			{ to: "+14155552671", text: "hello" },
		);
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not configured/);
	});
});
