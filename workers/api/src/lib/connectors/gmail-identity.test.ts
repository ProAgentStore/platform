import { beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_CONNECTOR } from "./gmail.js";
import type { Env } from "../../types.js";
import { renderToolContent } from "../tool-registry.js";
import type { RegistryToolCtx } from "./types.js";

/**
 * #1279 — a per-instance verified send-as identity and an enforced inbound-recipient scope.
 *
 * These tests drive the real tool handlers against a fake Gmail. What they pin is behaviour a gate could silently lose:
 * mail that must NOT leave (unverified / missing / wrong sender), mail that must NOT be read (out of scope, including
 * by direct id), and the default account staying exactly as it was for an agent that never configured any of this.
 */

const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify";
const ADMIN = "admin@freeappstore.online";
const HIRING = "hiring@freeappstore.online";
const PRIMARY = "owner@gmail.test";

const toolDef = (name: string) => {
	const t = GMAIL_CONNECTOR.tools.find((x) => x.name === name);
	if (!t?.handler) throw new Error(`no handler for ${name}`);
	return t;
};
const run = (name: string, ctx: RegistryToolCtx, input: Record<string, unknown>) => toolDef(name).handler(ctx, input);
const dispatched = async (name: string, ctx: RegistryToolCtx, input: Record<string, unknown>) => {
	const r = await run(name, ctx, input);
	return { ...r, content: renderToolContent(toolDef(name), r) };
};

type Identity = Record<string, unknown> | null | "corrupt";

function envWith(identity: Identity): Env {
	const config = identity === "corrupt" ? "{not json" : identity === null ? null : JSON.stringify({ gmailIdentity: identity });
	return {
		DB: {
			prepare: (sql: string) => ({
				bind: () => ({
					all: async () => ({ results: [{ account_id: PRIMARY, account_label: PRIMARY, created_at: "2026-08-01", granted_scopes: SCOPES }] }),
					first: async () => (sql.includes("agent_instances") ? { config } : { granted_scopes: SCOPES }),
				}),
			}),
		},
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({ fetch: async () => new Response(JSON.stringify({ permissions: { email: true } }), { status: 200 }) }),
		},
	} as unknown as Env;
}

const ctxFor = (env: Env): RegistryToolCtx =>
	({ env, userId: "u1", instanceId: "inst-1", connectorClient: (() => ({ token: async () => "access-token-SECRET" })) as unknown as RegistryToolCtx["connectorClient"] }) as RegistryToolCtx;

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface FakeMessage {
	id: string;
	headers: Record<string, string>;
	body?: string;
}

function raw(m: FakeMessage) {
	return {
		id: m.id,
		threadId: `t-${m.id}`,
		snippet: m.body?.slice(0, 40) ?? "",
		payload: {
			mimeType: "text/plain",
			filename: "",
			body: { data: b64u(m.body ?? "hello") },
			headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
		},
	};
}

const ALIASES = [
	{ sendAsEmail: PRIMARY, isPrimary: true, isDefault: true, displayName: "Owner" },
	{ sendAsEmail: ADMIN, displayName: "Free App Store Admin", verificationStatus: "accepted", replyToAddress: "" },
	{ sendAsEmail: HIRING, displayName: "Hiring", verificationStatus: "pending" },
];

interface Fake {
	calls: string[];
	sent: Array<{ raw: string; threadId?: string }>;
	drafts: Array<{ message: { raw: string } }>;
	modified: string[];
	mimeOf: (i?: number) => string;
}

function fakeGmail(opts: {
	messages?: FakeMessage[];
	aliases?: unknown[] | "forbidden";
	pages?: Array<{ ids: string[]; next?: string }>;
	failMetadata?: string[];
	listStatuses?: number[];
	draftFrom?: string;
} = {}): Fake {
	const messages = new Map((opts.messages ?? []).map((m) => [m.id, m]));
	const fake: Fake = { calls: [], sent: [], drafts: [], modified: [], mimeOf: () => "" };
	const statuses = [...(opts.listStatuses ?? [])];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const u = String(url);
		fake.calls.push(u);
		if (u.endsWith("/settings/sendAs")) {
			return opts.aliases === "forbidden" ? new Response("{}", { status: 403 }) : new Response(JSON.stringify({ sendAs: opts.aliases ?? ALIASES }), { status: 200 });
		}
		if (u.endsWith("/messages/send")) {
			fake.sent.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "sent-1", threadId: "t-1" }), { status: 200 });
		}
		if (u.endsWith("/drafts/send")) return new Response(JSON.stringify({ id: "sent-2", threadId: "t-2" }), { status: 200 });
		if (u.endsWith("/drafts")) {
			fake.drafts.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "d1", message: { id: "dm1", threadId: "t-9" } }), { status: 200 });
		}
		if (u.includes("/drafts/")) {
			return new Response(JSON.stringify({ message: raw({ id: "dm", headers: { From: opts.draftFrom ?? "" } }) }), { status: 200 });
		}
		if (u.includes("/modify")) {
			fake.modified.push(u);
			return new Response(JSON.stringify({ id: "m", labelIds: [] }), { status: 200 });
		}
		if (u.includes("/messages?")) {
			const status = statuses.shift();
			if (status && status !== 200) return new Response("{}", { status });
			const token = new URL(u).searchParams.get("pageToken");
			const page = opts.pages ? opts.pages[token ? Number(token.replace("P", "")) : 0] : { ids: [...messages.keys()] };
			return new Response(JSON.stringify({ messages: page.ids.map((id) => ({ id })), ...(page.next ? { nextPageToken: page.next } : {}) }), { status: 200 });
		}
		const m = /\/messages\/([^/?]+)/.exec(u);
		if (m) {
			const found = messages.get(decodeURIComponent(m[1]));
			if (!found || opts.failMetadata?.includes(found.id)) return new Response("{}", { status: found ? 500 : 404 });
			return new Response(JSON.stringify(raw(found)), { status: 200 });
		}
		return new Response("{}", { status: 404 });
	});
	fake.mimeOf = (i = 0) => {
		const b = fake.sent[i].raw.replace(/-/g, "+").replace(/_/g, "/");
		return new TextDecoder().decode(Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0)));
	};
	return fake;
}

const inbound = (id: string, to: string, extra: Record<string, string> = {}, body?: string): FakeMessage => ({
	id,
	body,
	headers: { From: "Candidate <cand@example.test>", To: to, Subject: "Application", "Message-ID": `<${id}@example.test>`, "Delivered-To": PRIMARY, ...extra },
});

const PINNED = { sendAs: ADMIN, inboundScope: [ADMIN] };

beforeEach(() => vi.unstubAllGlobals());

describe("an agent with no Gmail identity configured is unchanged", () => {
	it("sends without From or Reply-To, and never asks Gmail for aliases", async () => {
		const g = fakeGmail();
		const res = await run("gmail_send", ctxFor(envWith(null)), { to: "a@example.test", subject: "Hi", body: "Hello" });
		expect(res.success).toBe(true);
		const mime = g.mimeOf();
		expect(mime).not.toMatch(/^From:/m);
		expect(mime).not.toMatch(/^Reply-To:/m);
		expect(g.calls.some((c) => c.includes("sendAs"))).toBe(false);
	});

	it("searches with the query as given and does not scope it", async () => {
		const g = fakeGmail({ messages: [inbound("m1", "someone@else.test")] });
		const res = await run("gmail_search", ctxFor(envWith(null)), { query: "from:cand" });
		expect(res.success).toBe(true);
		const q = new URL(g.calls.find((c) => c.includes("/messages?"))!).searchParams.get("q");
		expect(q).toBe("from:cand");
		expect(res.content).toContain("m1");
	});

	it("replies to the parent's From even when the parent has a Reply-To (defaults are not changed for unconfigured agents)", async () => {
		const g = fakeGmail({ messages: [inbound("m1", "owner@gmail.test", { "Reply-To": "ats@jobs.example.test" })] });
		await run("gmail_reply", ctxFor(envWith(null)), { message_id: "m1", body: "ok" });
		expect(g.mimeOf()).toContain("To: Candidate <cand@example.test>");
	});
});

describe("send-as identity: explicit, sanitized, verified only", () => {
	it("emits From and Reply-To from the verified alias and its owner-set display name", async () => {
		const g = fakeGmail();
		const res = await run("gmail_send", ctxFor(envWith(PINNED)), { to: "cand@example.test", subject: "Interview", body: "Hello" });
		expect(res.success).toBe(true);
		const mime = g.mimeOf();
		expect(mime).toContain(`From: "Free App Store Admin" <${ADMIN}>`);
		expect(mime).toContain(`Reply-To: ${ADMIN}`);
		expect(res.content).toContain(ADMIN);
	});

	it("strips CR/LF and format characters from a display name so it cannot inject a header", async () => {
		const evil = [{ sendAsEmail: ADMIN, displayName: "Admin\r\nBcc: attacker@evil.test‮", verificationStatus: "accepted" }];
		const g = fakeGmail({ aliases: evil });
		const res = await run("gmail_send", ctxFor(envWith(PINNED)), { to: "cand@example.test", subject: "S", body: "B" });
		expect(res.success).toBe(true);
		const head = g.mimeOf().split("\r\n\r\n")[0];
		expect(head).not.toMatch(/^Bcc:/m);
		expect(head).not.toContain("‮");
		expect(head.split("\r\n").filter((l) => l.startsWith("From:"))).toHaveLength(1);
	});

	it("encodes a non-ASCII display name (RFC 2047) rather than emitting raw UTF-8", async () => {
		const g = fakeGmail({ aliases: [{ sendAsEmail: ADMIN, displayName: "管理者", verificationStatus: "accepted" }] });
		await run("gmail_send", ctxFor(envWith(PINNED)), { to: "cand@example.test", subject: "S", body: "B" });
		expect(g.mimeOf()).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <admin@freeappstore\.online>/m);
	});

	it("accepts the account's primary address, which Google reports without a verification status", async () => {
		const g = fakeGmail();
		const res = await run("gmail_send", ctxFor(envWith({ sendAs: PRIMARY, inboundScope: [] })), { to: "x@example.test", subject: "S", body: "B" });
		expect(res.success).toBe(true);
		expect(g.mimeOf()).toContain(`<${PRIMARY}>`);
	});

	it.each([
		["an alias Google has not verified", { sendAs: HIRING, inboundScope: [] }, /not verified|has not verified/],
		["an address that is not an alias of the account", { sendAs: "ghost@freeappstore.online", inboundScope: [] }, /not a send-as address/],
		["no sender chosen at all", { inboundScope: [ADMIN] }, /no sender address chosen/],
	])("refuses to send as %s — and nothing leaves", async (_name, identity, message) => {
		const g = fakeGmail();
		for (const tool of ["gmail_send", "gmail_reply", "gmail_draft_reply"]) {
			const res = await run(tool, ctxFor(envWith(identity)), { to: "x@example.test", subject: "S", body: "B", message_id: "m1" });
			expect(res.success, tool).toBe(false);
			expect(res.content, tool).toMatch(message);
		}
		expect(g.sent).toHaveLength(0);
		expect(g.drafts).toHaveLength(0);
	});

	it("refuses when the send-as lookup itself fails, instead of falling back to the default sender", async () => {
		const g = fakeGmail({ aliases: "forbidden" });
		const res = await run("gmail_send", ctxFor(envWith(PINNED)), { to: "x@example.test", subject: "S", body: "B" });
		expect(res.success).toBe(false);
		expect(res.content).toMatch(/could not be verified/);
		expect(g.sent).toHaveLength(0);
	});

	it("catches a pinned alias that was removed (or demoted) in Gmail after it was pinned", async () => {
		const g = fakeGmail({ aliases: [ALIASES[0]] });
		const res = await run("gmail_send", ctxFor(envWith(PINNED)), { to: "x@example.test", subject: "S", body: "B" });
		expect(res.success).toBe(false);
		expect(g.sent).toHaveLength(0);
	});

	it("refuses everything when the stored identity is corrupt — it does not degrade to the global default", async () => {
		const g = fakeGmail({ messages: [inbound("m1", ADMIN)] });
		for (const [tool, input] of [["gmail_send", { to: "x@example.test", subject: "S", body: "B" }], ["gmail_search", { query: "x" }], ["gmail_read_message", { message_id: "m1" }]] as const) {
			const res = await run(tool, ctxFor(envWith("corrupt")), input);
			expect(res.success, tool).toBe(false);
			expect(res.content, tool).toMatch(/paused until the owner re-saves/);
		}
		expect(g.sent).toHaveLength(0);
		const bad = await run("gmail_send", ctxFor(envWith({ sendAs: "not an address" })), { to: "x@example.test", subject: "S", body: "B" });
		expect(bad.success).toBe(false);
	});

	it("never puts the access token in a result", async () => {
		fakeGmail({ messages: [inbound("m1", ADMIN)] });
		for (const [tool, input] of [["gmail_send", { to: "x@example.test", subject: "S", body: "B" }], ["gmail_search", { query: "x" }], ["gmail_read_message", { message_id: "m1" }]] as const) {
			const res = await run(tool, ctxFor(envWith(PINNED)), input);
			expect(res.content).not.toContain("access-token-SECRET");
		}
	});
});

describe("inbound-recipient scope is enforced, not suggested", () => {
	const mail = [
		inbound("in1", ADMIN),
		inbound("other", "someone@else.test"),
		inbound("mixed", `Hiring <${HIRING}>, ${ADMIN}`),
		inbound("cc", "someone@else.test", { Cc: ADMIN }),
		inbound("spoof", `"${ADMIN}" <attacker@evil.test>`),
		inbound("lookalike", "admin@freeappstore.online.evil.test"),
	];

	it("narrows the search query to the scope and lets the agent's query only narrow it further", async () => {
		const g = fakeGmail({ messages: mail });
		await run("gmail_search", ctxFor(envWith(PINNED)), { query: "from:cand OR from:anyone" });
		const q = new URL(g.calls.find((c) => c.includes("/messages?"))!).searchParams.get("q")!;
		expect(q).toBe(`(to:${ADMIN} OR cc:${ADMIN} OR deliveredto:${ADMIN}) (from:cand OR from:anyone)`);
	});

	it("drops hits whose headers are not addressed to the scope even if Gmail matched them, and says how many", async () => {
		fakeGmail({ messages: mail });
		const res = await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x" });
		const out = JSON.parse(res.content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(out.messages.map((m: { id: string }) => m.id).sort()).toEqual(["cc", "in1", "mixed"]);
		expect(out.out_of_scope_omitted).toBe(3);
	});

	it("refuses a direct-id read of out-of-scope mail and returns none of its content", async () => {
		fakeGmail({ messages: [inbound("other", "someone@else.test", {}, "SECRET-BODY-OF-OTHER")] });
		const res = await run("gmail_read_message", ctxFor(envWith(PINNED)), { message_id: "other" });
		expect(res.success).toBe(false);
		expect(res.content).not.toContain("SECRET-BODY-OF-OTHER");
		expect(res.content).toMatch(/not addressed to this agent's mailbox/);
	});

	it("reads mixed-recipient mail that names the scope address among others", async () => {
		fakeGmail({ messages: [inbound("mixed", `Hiring <${HIRING}>, ${ADMIN}`, {}, "visible body")] });
		const res = await run("gmail_read_message", ctxFor(envWith(PINNED)), { message_id: "mixed" });
		expect(res.success).toBe(true);
		expect(res.content).toContain("visible body");
	});

	it("does not treat a display name or a lookalike domain as the scope address", async () => {
		fakeGmail({ messages: mail });
		for (const id of ["spoof", "lookalike"]) {
			expect((await run("gmail_read_message", ctxFor(envWith(PINNED)), { message_id: id })).success, id).toBe(false);
		}
	});

	it("blocks reply, draft, attachment download, archive and mark-read on out-of-scope mail", async () => {
		const g = fakeGmail({ messages: mail });
		const c = ctxFor(envWith(PINNED));
		for (const [tool, input] of [
			["gmail_reply", { message_id: "other", body: "hi" }],
			["gmail_draft_reply", { message_id: "other", body: "hi" }],
			["gmail_download_attachment", { message_id: "other", attachment_id: "a" }],
			["gmail_archive", { message_id: "other" }],
			["gmail_mark_read", { message_id: "other" }],
		] as const) {
			const res = await run(tool, c, input);
			expect(res.success, tool).toBe(false);
			expect(res.content, tool).toMatch(/not addressed to this agent's mailbox/);
		}
		expect(g.sent).toHaveLength(0);
		expect(g.drafts).toHaveLength(0);
		expect(g.modified).toHaveLength(0);
	});

	it("still lets in-scope mail be archived", async () => {
		const g = fakeGmail({ messages: mail });
		const res = await run("gmail_archive", ctxFor(envWith(PINNED)), { message_id: "in1" });
		expect(res.success).toBe(true);
		expect(g.modified).toHaveLength(1);
	});

	it("an identity with a sender but no scope leaves reading unscoped", async () => {
		const g = fakeGmail({ messages: mail });
		await run("gmail_search", ctxFor(envWith({ sendAs: ADMIN, inboundScope: [] })), { query: "x" });
		expect(new URL(g.calls.find((c) => c.includes("/messages?"))!).searchParams.get("q")).toBe("x");
	});
});

describe("replies and threading", () => {
	const parent = (extra: Record<string, string> = {}) =>
		inbound("p1", `${ADMIN}, Colleague <colleague@example.test>`, { Cc: "third@example.test", References: "<root@example.test>", ...extra });

	it("sends as the pinned sender, in the parent's thread, with the usual threading headers", async () => {
		const g = fakeGmail({ messages: [parent()] });
		const res = await run("gmail_reply", ctxFor(envWith(PINNED)), { message_id: "p1", body: "Thanks" });
		expect(res.success).toBe(true);
		const mime = g.mimeOf();
		expect(mime).toContain(`From: "Free App Store Admin" <${ADMIN}>`);
		expect(mime).toContain("In-Reply-To: <p1@example.test>");
		expect(mime).toContain("References: <root@example.test> <p1@example.test>");
		expect(mime).toContain("Subject: Re: Application");
		expect(g.sent[0].threadId).toBe("t-p1");
	});

	it("honours a single valid Reply-To on the parent and reports that it did", async () => {
		const g = fakeGmail({ messages: [parent({ "Reply-To": "Recruiter <recruiter@ats.example.test>" })] });
		const res = await run("gmail_reply", ctxFor(envWith(PINNED)), { message_id: "p1", body: "Thanks" });
		expect(g.mimeOf()).toMatch(/^To: recruiter@ats\.example\.test$/m);
		expect(res.content).toContain('"reply_to_honoured": true');
	});

	it.each([
		["several addresses", "a@x.test, b@x.test"],
		["something that is not an address", "not an address"],
		["this agent's own address", ADMIN],
	])("falls back to the parent's From when the Reply-To is %s", async (_n, replyTo) => {
		const g = fakeGmail({ messages: [parent({ "Reply-To": replyTo })] });
		const res = await run("gmail_reply", ctxFor(envWith(PINNED)), { message_id: "p1", body: "Thanks" });
		expect(res.success).toBe(true);
		expect(g.mimeOf()).toContain("To: Candidate <cand@example.test>");
		expect(res.content).toContain('"reply_to_honoured": false');
	});

	it("reply_all copies the others but never the agent itself or the primary recipient, and never takes a recipient from the model", async () => {
		const g = fakeGmail({ messages: [parent()] });
		await run("gmail_reply", ctxFor(envWith(PINNED)), { message_id: "p1", body: "Thanks", reply_all: true, to: "attacker@evil.test", cc: "attacker@evil.test" });
		const mime = g.mimeOf();
		expect(mime).toMatch(/^Cc: colleague@example\.test, third@example\.test$/m);
		expect(mime).not.toContain("attacker@evil.test");
		expect(mime).not.toMatch(/^Cc:.*admin@freeappstore/m);
	});

	it("a draft reply carries the same From, Reply-To and threading", async () => {
		const g = fakeGmail({ messages: [parent()] });
		const res = await run("gmail_draft_reply", ctxFor(envWith(PINNED)), { message_id: "p1", body: "Draft" });
		expect(res.success).toBe(true);
		const b = g.drafts[0].message.raw.replace(/-/g, "+").replace(/_/g, "/");
		const mime = new TextDecoder().decode(Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0)));
		expect(mime).toContain(`From: "Free App Store Admin" <${ADMIN}>`);
		expect(mime).toContain(`Reply-To: ${ADMIN}`);
		expect(mime).toContain("In-Reply-To: <p1@example.test>");
	});

	it("sends an existing draft only if it was written as the pinned sender", async () => {
		const wrong = fakeGmail({ draftFrom: "Someone Else <owner@gmail.test>" });
		const refused = await run("gmail_draft_send", ctxFor(envWith(PINNED)), { draft_id: "d1" });
		expect(refused.success).toBe(false);
		expect(refused.content).toContain(ADMIN);
		expect(wrong.calls.some((c) => c.endsWith("/drafts/send"))).toBe(false);

		const right = fakeGmail({ draftFrom: `"Free App Store Admin" <${ADMIN}>` });
		const sent = await run("gmail_draft_send", ctxFor(envWith(PINNED)), { draft_id: "d1" });
		expect(sent.success).toBe(true);
		expect(right.calls.some((c) => c.endsWith("/drafts/send"))).toBe(true);
	});
});

describe("bounded bodies, paging and retries", () => {
	const long = "0123456789".repeat(2_500); // 25,000 characters

	it("a scoped read returns a bounded preview and a continuation, and the pieces rebuild the body exactly", async () => {
		fakeGmail({ messages: [inbound("big", ADMIN, {}, long)] });
		const c = ctxFor(envWith(PINNED));
		let text = "";
		let offset = 0;
		let reads = 0;
		for (;;) {
			const res = await run("gmail_read_message", c, { message_id: "big", offset });
			const out = JSON.parse(res.content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
			expect(out.text.length).toBeLessThanOrEqual(8_000);
			expect(out.textLength).toBe(25_000);
			text += out.text;
			reads++;
			if (!out.truncated) {
				expect(out.nextOffset).toBeNull();
				break;
			}
			expect(out.nextOffset).toBe(offset + out.text.length);
			offset = out.nextOffset;
		}
		expect(reads).toBe(4);
		expect(text).toBe(long);
	});

	it("max_chars is clamped to the hard ceiling, and an unconfigured read announces its cut instead of hiding it", async () => {
		fakeGmail({ messages: [inbound("big", ADMIN, {}, long.repeat(2))] });
		const scoped = JSON.parse((await run("gmail_read_message", ctxFor(envWith(PINNED)), { message_id: "big", max_chars: 9_999_999 })).content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(scoped.text.length).toBe(40_000);
		const plain = JSON.parse((await run("gmail_read_message", ctxFor(envWith(null)), { message_id: "big" })).content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(plain.text.length).toBe(40_000);
		expect(plain.truncated).toBe(true);
		expect(plain.nextOffset).toBe(40_000);
	}, 30_000);

	it("clips summary fields on a scoped listing and marks the cut", async () => {
		fakeGmail({ messages: [inbound("s1", ADMIN, { Subject: "S".repeat(900) })] });
		const res = await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x" });
		expect(res.content).toMatch(/\[cut: showing the first 300 of 900 characters\]/);
	});

	it("returns Gmail's next page token and sends it back for the following page", async () => {
		const msgs = [inbound("a", ADMIN), inbound("b", ADMIN)];
		const g = fakeGmail({ messages: msgs, pages: [{ ids: ["a"], next: "P1" }, { ids: ["b"] }] });
		const first = JSON.parse((await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x", max: 1 })).content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(first.messages.map((m: { id: string }) => m.id)).toEqual(["a"]);
		expect(first.next_page_token).toBe("P1");
		const second = JSON.parse((await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x", max: 1, page_token: first.next_page_token })).content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(second.messages.map((m: { id: string }) => m.id)).toEqual(["b"]);
		expect(second.next_page_token).toBeUndefined();
		expect(g.calls.some((c) => c.includes("pageToken=P1"))).toBe(true);
	});

	it("refuses a page token that is not one Gmail could have issued", async () => {
		const g = fakeGmail({ messages: [inbound("a", ADMIN)] });
		const res = await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x", page_token: "P1&q=in:anywhere" });
		expect(res.success).toBe(false);
		expect(g.calls.some((c) => c.includes("/messages?"))).toBe(false);
	});

	it("counts a message it could not read, so a short page is not mistaken for the last one", async () => {
		fakeGmail({ messages: [inbound("a", ADMIN), inbound("b", ADMIN)], failMetadata: ["b"] });
		const out = JSON.parse((await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x" })).content.replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
		expect(out.messages).toHaveLength(1);
		expect(out.unreadable).toBe(1);
	});

	it("retries a rate-limited listing and succeeds, and gives up with Gmail's status after the budget", async () => {
		const g = fakeGmail({ messages: [inbound("a", ADMIN)], listStatuses: [429, 503, 200] });
		const ok = await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x" });
		expect(ok.success).toBe(true);
		expect(g.calls.filter((c) => c.includes("/messages?"))).toHaveLength(3);

		fakeGmail({ messages: [inbound("a", ADMIN)], listStatuses: [429, 429, 429, 429] });
		const dead = await run("gmail_search", ctxFor(envWith(PINNED)), { query: "x" });
		expect(dead.success).toBe(false);
		expect(dead.content).toContain("429");
	});

	it("keeps the consent gate: every sending and changing tool is still a write tool", () => {
		for (const name of ["gmail_send", "gmail_reply", "gmail_draft_reply", "gmail_draft_send", "gmail_archive", "gmail_mark_read"]) {
			expect(toolDef(name).scope, name).toBe("write");
		}
		for (const name of ["gmail_search", "gmail_read_message"]) expect(toolDef(name).scope, name).toBe("read");
	});

	it("fences the scoped listing like any mailbox content", async () => {
		fakeGmail({ messages: [inbound("a", ADMIN)] });
		const res = await dispatched("gmail_search", ctxFor(envWith(PINNED)), { query: "x" });
		expect(res.content).toContain("untrusted");
	});
});
