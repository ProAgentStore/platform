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
	it("asks for readonly + send, and NOT gmail.modify (#713)", () => {
		expect(GMAIL_MANIFEST.auth).toMatchObject({ type: "oauth2" });
		const scopes = (GMAIL_MANIFEST.auth as { scopes: string[] }).scopes;
		expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
		expect(scopes).toContain("https://www.googleapis.com/auth/gmail.send");
		// gmail.modify would cover sending too, and would also let a bug delete the owner's mail.
		// Requesting the narrower scope is the decision; this is what stops it being widened quietly.
		expect(scopes.some((x) => x.includes("gmail.modify") || x === "https://mail.google.com/")).toBe(false);
	});

	it("declares write reach now, which is what puts sending behind the #90 consent gate", () => {
		// Derived from the tools by compileConnector, not hand-declared: a write-scoped tool on a
		// write:false connector is refused by assertScope before any handler runs.
		expect(GMAIL_CONNECTOR.scopes).toEqual({ read: true, write: true });
		const writeTools = GMAIL_CONNECTOR.tools.filter((t) => t.scope === "write").map((t) => t.name);
		expect(writeTools).toEqual(["gmail_reply", "gmail_send"]);
	});

	it("keeps find_confirmation_link OUT of the connector — its grant model is the odd one out", () => {
		expect(GMAIL_CONNECTOR.tools.some((t) => t.name === "find_confirmation_link")).toBe(false);
	});
});

// ── #713: the send tools ─────────────────────────────────────────────────────

/** An env whose DB reports the given granted_scopes, and whose DO answers state + files. */
function sendEnv(opts: {
	grantedScopes: string | null;
	fileBytes?: string;
	fileName?: string;
	onFilePost?: (body: Record<string, unknown>) => void;
}): Env {
	return {
		DB: {
			prepare: () => ({
				bind: () => ({ first: async () => ({ granted_scopes: opts.grantedScopes }) }),
			}),
		},
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: async (req: Request) => {
					const path = new URL(req.url).pathname;
					if (path === "/state") return new Response(JSON.stringify({ permissions: { email: true } }), { status: 200 });
					if (path.startsWith("/files/")) {
						if (opts.fileBytes === undefined) return new Response("not found", { status: 404 });
						return new Response(opts.fileBytes, {
							status: 200,
							headers: {
								"Content-Type": "application/pdf",
								"X-File-Meta": JSON.stringify({ id: "f1", name: opts.fileName ?? "Form.pdf" }),
							},
						});
					}
					opts.onFilePost?.((await req.json()) as Record<string, unknown>);
					return new Response(JSON.stringify({ id: "f1" }), { status: 201 });
				},
			}),
		},
	} as unknown as Env;
}

const PARENT = {
	id: "m1",
	threadId: "t-42",
	payload: {
		mimeType: "text/plain",
		filename: "",
		body: { data: btoa("original").replace(/=+$/, "") },
		headers: [
			{ name: "From", value: "Kelly <kelly@example.test>" },
			{ name: "To", value: "parent@example.test" },
			{ name: "Cc", value: "other@example.test" },
			{ name: "Subject", value: "Summer Competition Form" },
			{ name: "Message-ID", value: "<orig@example.test>" },
			{ name: "References", value: "<root@example.test>" },
		],
	},
};

/** Capture what was POSTed to Gmail's send endpoint, and decode the raw MIME back. */
function stubGmail(parent: unknown = PARENT) {
	const sent: Array<{ raw: string; threadId?: string }> = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		if (String(url).endsWith("/messages/send")) {
			sent.push(JSON.parse(String(init?.body)) as { raw: string; threadId?: string });
			return new Response(JSON.stringify({ id: "sent-1", threadId: "t-42" }), { status: 200 });
		}
		return new Response(JSON.stringify(parent), { status: 200 });
	});
	const mimeOf = (i = 0) => {
		const b64 = sent[i].raw.replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
	};
	return { sent, mimeOf };
}

const SEND_SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

describe("the scope migration", () => {
	it("refuses to send on a connection granted before the send scope, naming the fix", async () => {
		const { sent } = stubGmail();
		for (const name of ["gmail_reply", "gmail_send"]) {
			const res = await tool(name)(ctxWith(sendEnv({ grantedScopes: "https://www.googleapis.com/auth/gmail.readonly" })), {
				message_id: "m1",
				to: "x@y.test",
				subject: "s",
				body: "hello",
			});
			expect(res.success, name).toBe(false);
			expect(res.content, name).toMatch(/Reconnect Gmail/);
		}
		// The refusal happens BEFORE the API call — that is the whole point of recording scopes.
		expect(sent).toHaveLength(0);
	});

	it("refuses when the grant predates the column entirely (granted_scopes NULL)", async () => {
		stubGmail();
		const res = await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: null })), { message_id: "m1", body: "hi" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/reading only/);
	});

	it("still refuses a send when email permission is off, before it ever looks at scopes", async () => {
		stubGmail();
		const res = await tool("gmail_send")(ctxWith(envWithPermission(false)), { to: "a@b.test", subject: "s", body: "b" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/Email access is not enabled/);
	});
});

describe("gmail_reply", () => {
	it("threads the reply: In-Reply-To, an extended References chain, and the parent threadId", async () => {
		const { sent, mimeOf } = stubGmail();
		const res = await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), {
			message_id: "m1",
			body: "Yes please.",
		});
		expect(res.success).toBe(true);
		const mime = mimeOf();
		expect(mime).toContain("In-Reply-To: <orig@example.test>");
		expect(mime).toContain("References: <root@example.test> <orig@example.test>");
		expect(mime).toContain("Subject: Re: Summer Competition Form");
		// threadId threads the SENDER's copy; the headers thread the recipient's. Both are needed.
		expect(sent[0].threadId).toBe("t-42");
	});

	it("addresses the reply to the parent's sender, never to a model-supplied address", async () => {
		const { mimeOf } = stubGmail();
		await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), {
			message_id: "m1",
			body: "hi",
			// An injected instruction in the mail the agent just read might well produce this.
			to: "attacker@evil.test",
		});
		const mime = mimeOf();
		expect(mime).toContain("To: Kelly <kelly@example.test>");
		expect(mime).not.toContain("attacker@evil.test");
	});

	it("copies the original recipients only when reply_all is asked for", async () => {
		const a = stubGmail();
		await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), { message_id: "m1", body: "hi" });
		expect(a.mimeOf()).not.toContain("Cc:");

		const b = stubGmail();
		await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), { message_id: "m1", body: "hi", reply_all: true });
		expect(b.mimeOf()).toContain("Cc: parent@example.test, other@example.test");
	});

	it("attaches a file from the agent's store by id", async () => {
		const { mimeOf } = stubGmail();
		const res = await tool("gmail_reply")(
			ctxWith(sendEnv({ grantedScopes: SEND_SCOPES, fileBytes: "%PDF-1.4 filled", fileName: "SummerComp-filled.pdf" })),
			{ message_id: "m1", body: "Form attached.", attachment_file_ids: ["f1"] },
		);
		expect(res.success).toBe(true);
		const mime = mimeOf();
		expect(mime).toContain('filename="SummerComp-filled.pdf"');
		expect(mime).toContain(btoa("%PDF-1.4 filled"));
		expect(res.content).toContain("SummerComp-filled.pdf");
	});

	it("refuses rather than sending a half-complete message when an attachment is missing", async () => {
		const { sent } = stubGmail();
		const res = await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), {
			message_id: "m1",
			body: "hi",
			attachment_file_ids: ["missing"],
		});
		expect(res.success).toBe(false);
		// Sending "please find attached" with nothing attached is worse than not sending.
		expect(sent).toHaveLength(0);
	});

	it("requires a body — an empty reply is never what was meant", async () => {
		const res = await tool("gmail_reply")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), { message_id: "m1", body: "   " });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/body is required/);
	});
});

describe("gmail_send", () => {
	it("sends to the address it is given, with no thread", async () => {
		const { sent, mimeOf } = stubGmail();
		const res = await tool("gmail_send")(ctxWith(sendEnv({ grantedScopes: SEND_SCOPES })), {
			to: "kelly@example.test",
			subject: "Entry",
			body: "Yes please.",
		});
		expect(res.success).toBe(true);
		expect(mimeOf()).toContain("To: kelly@example.test");
		expect(sent[0].threadId).toBeUndefined();
	});

	it("requires to, subject and body", async () => {
		const env = sendEnv({ grantedScopes: SEND_SCOPES });
		for (const input of [{ subject: "s", body: "b" }, { to: "a@b.test", body: "b" }, { to: "a@b.test", subject: "s" }]) {
			expect((await tool("gmail_send")(ctxWith(env), input)).success).toBe(false);
		}
	});
});
