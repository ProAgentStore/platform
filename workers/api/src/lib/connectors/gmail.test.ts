import { describe, expect, it, vi, beforeEach } from "vitest";
import { GMAIL_CONNECTOR, GMAIL_MANIFEST } from "./gmail.js";
import type { Env } from "../../types.js";
import type { RegistryToolCtx } from "./types.js";

/**
 * The gate is what these tests are for.
 *
 * Every tool here reaches into a real person's mailbox, so the interesting assertions are not
 * "does it return messages" but "what does it do when it is not allowed to". Each refusal path
 * gets its own test, because the failure mode that matters is a gate that silently stops
 * gating — and a gate that has no test looks identical to one that does.
 */

const tool = (name: string) => {
	const t = GMAIL_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no handler for ${name}`);
	return t.handler;
};

/** An env whose instance DO reports the given `permissions.email`, or fails outright. */
function envWithPermission(email: boolean | "unreachable" | "not-ok"): Env {
	return {
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: async () => {
					if (email === "unreachable") throw new Error("DO exploded");
					if (email === "not-ok") return new Response("nope", { status: 500 });
					return new Response(JSON.stringify({ permissions: { email } }), { status: 200 });
				},
			}),
		},
	} as unknown as Env;
}

function ctxWith(env: Env, token = "access-token", overrides: Partial<RegistryToolCtx> = {}): RegistryToolCtx {
	return {
		env,
		userId: "u1",
		instanceId: "inst-1",
		connectorClient: (() => ({ token: async () => token })) as unknown as RegistryToolCtx["connectorClient"],
		...overrides,
	} as RegistryToolCtx;
}

beforeEach(() => vi.unstubAllGlobals());

describe("the permissions.email gate", () => {
	// `capabilities.tools` already gates which tools an agent gets. This asserts the SECOND gate:
	// the owner's switch. If declaring gmail_search were enough, a catalog agent would grant
	// itself mailbox reach by its own declaration.
	it("refuses every tool when the owner has not enabled email for the agent", async () => {
		const ctx = ctxWith(envWithPermission(false));
		for (const name of ["gmail_search", "gmail_read_message", "gmail_download_attachment"]) {
			const res = await tool(name)(ctx, { message_id: "m1", attachment_id: "a1" });
			expect(res.success, name).toBe(false);
			expect(res.content, name).toMatch(/Email access is not enabled/);
		}
	});

	it("fails closed when the permission source is unreachable", async () => {
		const res = await tool("gmail_search")(ctxWith(envWithPermission("unreachable")), {});
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/Email access is not enabled/);
	});

	it("fails closed when the permission source answers non-OK", async () => {
		const res = await tool("gmail_search")(ctxWith(envWithPermission("not-ok")), {});
		expect(res.success).toBe(false);
	});

	it("fails closed when there is no instance to resolve a permission against", async () => {
		const res = await tool("gmail_search")(ctxWith(envWithPermission(true), "tok", { instanceId: undefined }), {});
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/Email access is not enabled/);
	});

	it("refuses without an authenticated user even when permission would be granted", async () => {
		const res = await tool("gmail_search")(ctxWith(envWithPermission(true), "tok", { userId: undefined }), {});
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/authenticated user/);
	});

	it("explains that Gmail is not connected when no token can be minted", async () => {
		const res = await tool("gmail_search")(ctxWith(envWithPermission(true), ""), {});
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/not connected/);
	});
});

describe("gmail_search", () => {
	it("passes a raw query straight through, in preference to the structured hints", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(String(url));
			return new Response(JSON.stringify({}), { status: 200 });
		});
		await tool("gmail_search")(ctxWith(envWithPermission(true)), {
			query: "from:kelly has:attachment",
			from: "ignored",
			within_days: 99,
		});
		expect(decodeURIComponent(urls[0])).toContain("from:kelly has:attachment");
		expect(decodeURIComponent(urls[0])).not.toContain("ignored");
	});

	it("falls back to the structured hints when no raw query is given", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(String(url));
			return new Response(JSON.stringify({}), { status: 200 });
		});
		await tool("gmail_search")(ctxWith(envWithPermission(true)), { from: "kelly", within_days: 14 });
		expect(decodeURIComponent(urls[0])).toContain("from:kelly");
	});

	it("reports no match as a success with the query, not as an error", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({}), { status: 200 }));
		const res = await tool("gmail_search")(ctxWith(envWithPermission(true)), { from: "nobody" });
		// A search that found nothing WORKED. Returning success:false here would make the model
		// retry or apologise for a failure that never happened.
		expect(res.success).toBe(true);
		expect(res.content).toMatch(/No messages matched/);
	});
});

describe("gmail_download_attachment", () => {
	const MESSAGE = {
		id: "m1",
		threadId: "t1",
		payload: {
			mimeType: "multipart/mixed",
			filename: "",
			parts: [{ mimeType: "application/pdf", filename: "Form.pdf", body: { attachmentId: "att-1", size: 1024 } }],
		},
	};

	it("requires both ids", async () => {
		const res = await tool("gmail_download_attachment")(ctxWith(envWithPermission(true)), { message_id: "m1" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/both required/);
	});

	it("refuses an attachment id the message does not have, and lists what it does have", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(MESSAGE), { status: 200 }));
		const res = await tool("gmail_download_attachment")(ctxWith(envWithPermission(true)), {
			message_id: "m1",
			attachment_id: "wrong-id",
		});
		expect(res.success).toBe(false);
		expect(res.content).toContain("Form.pdf");
	});

	it("refuses an attachment over the size cap before fetching its bytes", async () => {
		const huge = { ...MESSAGE, payload: { ...MESSAGE.payload, parts: [{ mimeType: "video/mp4", filename: "big.mp4", body: { attachmentId: "att-1", size: 99 * 1024 * 1024 } }] } };
		let fetches = 0;
		vi.stubGlobal("fetch", async () => {
			fetches++;
			return new Response(JSON.stringify(huge), { status: 200 });
		});
		const res = await tool("gmail_download_attachment")(ctxWith(envWithPermission(true)), { message_id: "m1", attachment_id: "att-1" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/over the .*MB limit/);
		// One fetch (the metadata read), not two — the bytes were never pulled.
		expect(fetches).toBe(1);
	});

	it("stores the bytes in the instance file store and returns a file_id, never the contents", async () => {
		const posted: Array<Record<string, unknown>> = [];
		vi.stubGlobal("fetch", async (url: string) => {
			if (String(url).includes("/attachments/")) {
				return new Response(JSON.stringify({ data: btoa("%PDF-1.4 fake").replace(/\+/g, "-").replace(/\//g, "_"), size: 12 }), { status: 200 });
			}
			return new Response(JSON.stringify(MESSAGE), { status: 200 });
		});
		const env = {
			AGENT: {
				idFromName: (n: string) => n,
				get: () => ({
					fetch: async (req: Request) => {
						if (new URL(req.url).pathname === "/state") {
							return new Response(JSON.stringify({ permissions: { email: true } }), { status: 200 });
						}
						posted.push((await req.json()) as Record<string, unknown>);
						return new Response(JSON.stringify({ id: "file-77", name: "Form.pdf", size: 12 }), { status: 201 });
					},
				}),
			},
		} as unknown as Env;

		const res = await tool("gmail_download_attachment")(ctxWith(env), { message_id: "m1", attachment_id: "att-1" });
		expect(res.success).toBe(true);
		expect(res.content).toContain("file-77");
		// The whole point: bytes go to storage, not into the model's context.
		expect(res.content).not.toContain("%PDF");
		expect(posted[0]).toMatchObject({ name: "Form.pdf", mime_type: "application/pdf" });
		expect(String(posted[0].contentBase64)).not.toMatch(/[-_]/); // translated to standard base64
	});
});

describe("the declaration", () => {
	it("still asks for gmail.readonly only — this issue needs no new scope", () => {
		expect(GMAIL_MANIFEST.auth).toMatchObject({ type: "oauth2" });
		const scopes = (GMAIL_MANIFEST.auth as { scopes: string[] }).scopes;
		expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
		expect(scopes.some((s) => s.includes("gmail.send") || s.includes("gmail.modify"))).toBe(false);
	});

	it("declares read-only reach, so the #90 write-consent gate has nothing to consent to yet", () => {
		expect(GMAIL_CONNECTOR.scopes).toEqual({ read: true, write: false });
	});

	it("keeps find_confirmation_link OUT of the connector — its grant model is the odd one out", () => {
		expect(GMAIL_CONNECTOR.tools.some((t) => t.name === "find_confirmation_link")).toBe(false);
	});
});
