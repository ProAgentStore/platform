import { describe, expect, it } from "vitest";
import { buildQuery, extractCode, extractLinks, rankConfirmationLinks } from "./gmail.js";

/**
 * Fixture tokens here are deliberately LOW-ENTROPY and say so in the value itself (#295).
 *
 * They used to be mixed-case-and-digit runs of ~20 characters — random-looking enough that
 * gitleaks' `generic-api-key` rule (a `token`-ish keyword followed by a high-entropy value)
 * reported eight findings in this one file. Eight of the eleven findings in the whole repo, in
 * fact, all of them fake. (The originals are not reproduced here: quoting them in the comment
 * that explains their removal puts them straight back in the scan — measured, it did.) That is
 * the failure mode a secret scanner has to avoid: a
 * report that is mostly noise is a report nobody reads, and the real leak arrives in the middle
 * of it.
 *
 * Nothing under test reads the token's CONTENT. `extractLinks` matches URL shape and
 * `rankConfirmationLinks` scores on path keywords, the domain hint, and asset extensions — the
 * one length-sensitive rule (`/[?&/][a-z0-9]{16,}/`) needs the run to follow `?`, `&` or `/`, and
 * these values sit after `=`, so it never applied to them either way. Keep new fixtures the same
 * shape: recognisably not a secret, to a scanner as well as to a reader.
 */

describe("extractCode", () => {
	it("prefers a context-anchored code", () => {
		expect(extractCode("Your verification code is 483920. It expires soon.")).toBe("483920");
	});
	it("finds a bare 6-digit code", () => {
		expect(extractCode("<p>Use 728104 to sign in</p>")).toBe("728104");
	});
	it("returns null when there is nothing code-like", () => {
		expect(extractCode("Welcome to Coles careers, thanks for applying.")).toBeNull();
	});
});

describe("extractLinks", () => {
	it("pulls href and bare links from an html body", () => {
		const body = `
			<p>Welcome! <a href="https://coles.com.au/confirm?token=example-not-a-real-token">Confirm</a></p>
			Visit https://coles.com.au/help for help.
		`;
		const links = extractLinks(body);
		expect(links).toContain("https://coles.com.au/confirm?token=example-not-a-real-token");
		expect(links).toContain("https://coles.com.au/help");
	});

	it("returns no links when there are none", () => {
		expect(extractLinks("just text, no urls")).toEqual([]);
	});
});

describe("rankConfirmationLinks", () => {
	it("ranks the confirmation link above noise", () => {
		const links = [
			"https://coles.com.au/unsubscribe?u=1",
			"https://coles.com.au/privacy",
			"https://coles.com.au/verify?token=example-not-a-real-token",
			"https://coles.com.au/help",
		];
		const ranked = rankConfirmationLinks(links, "coles");
		expect(ranked[0]).toBe("https://coles.com.au/verify?token=example-not-a-real-token");
	});

	it("deprioritises unsubscribe/privacy links", () => {
		const ranked = rankConfirmationLinks([
			"https://x.com/unsubscribe",
			"https://x.com/activate/aaaaaaaaaaaaaaaaaaaa",
		]);
		expect(ranked[0]).toContain("activate");
	});
});

describe("buildQuery", () => {
	it("composes from + subject + recency", () => {
		expect(buildQuery({ from: "coles", subject: "confirm your account", withinDays: 2 })).toBe(
			"from:coles subject:(confirm your account) newer_than:2d",
		);
	});

	it("defaults recency to 1 day and clamps to 7", () => {
		expect(buildQuery({})).toBe("newer_than:1d");
		expect(buildQuery({ withinDays: 99 })).toBe("newer_than:7d");
	});
});

describe("extractLinks drops assets", () => {
	it("skips image/css URLs, keeps the real link", () => {
		const body = `<img src="https://mail.coles.com.au/logo.png"><a href="https://colescareers.com.au/onetime-login?token=example-not-a-real-token">Sign in</a>`;
		const links = extractLinks(body);
		expect(links).toContain("https://colescareers.com.au/onetime-login?token=example-not-a-real-token");
		expect(links.some((l) => l.endsWith(".png"))).toBe(false);
	});
});

describe("rankConfirmationLinks prefers the sign-in link", () => {
	it("ranks a one-time login link above an image and unsubscribe", () => {
		const links = [
			"https://mail.colescareers.com.au/banner.jpg",
			"https://colescareers.com.au/unsubscribe?u=1",
			"https://colescareers.com.au/onetime-login?token=example-not-a-real-token",
		];
		expect(rankConfirmationLinks(links, "colescareers")[0]).toBe("https://colescareers.com.au/onetime-login?token=example-not-a-real-token");
	});
});

// ── #711: reading a message properly ─────────────────────────────────────────

/**
 * A realistic Gmail `format=full` payload: `multipart/mixed` wrapping a
 * `multipart/alternative` (the plain+html body pair Gmail actually sends) plus two attachments.
 *
 * The nesting is the whole point of the fixture. A flat walk that only looks at `payload.parts`
 * finds the attachments but loses the body, because the body is one level deeper — which is the
 * shape almost every real "please find attached" email arrives in.
 */
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const NESTED_MESSAGE = {
	id: "msg-1",
	threadId: "thread-9",
	snippet: "Attached is the Junior Summer Competition Form",
	payload: {
		mimeType: "multipart/mixed",
		filename: "",
		headers: [
			{ name: "From", value: "Kelly Cooper <str8.sets@bigpond.com>" },
			{ name: "To", value: "parent@example.com" },
			{ name: "Subject", value: "Summer Competition Form" },
			{ name: "Date", value: "Sun, 9 Aug 2026 19:28:58 +1000" },
			{ name: "Message-ID", value: "<abc123@bigpond.com>" },
			{ name: "References", value: "<root@bigpond.com>" },
		],
		parts: [
			{
				mimeType: "multipart/alternative",
				filename: "",
				parts: [
					{ mimeType: "text/plain", filename: "", body: { data: b64url("All forms need to be returned by Sunday 30th August") } },
					{ mimeType: "text/html", filename: "", body: { data: b64url("<p>All forms need to be returned</p>") } },
				],
			},
			{ mimeType: "application/pdf", filename: "SummerComp.pdf", body: { attachmentId: "att-1", size: 84210 } },
			{ mimeType: "application/pdf", filename: "JuniorChamps.pdf", body: { attachmentId: "att-2", size: 51200 } },
			// An inline logo: a non-text part with NO filename. Must not be reported as an attachment.
			{ mimeType: "image/png", filename: "", body: { attachmentId: "att-logo", size: 900 } },
		],
	},
};

describe("collectAttachments", () => {
	it("finds attachments nested under a multipart/alternative body", async () => {
		const { collectAttachments } = await import("./gmail.js");
		const found = collectAttachments(NESTED_MESSAGE.payload);
		expect(found.map((a) => a.filename)).toEqual(["SummerComp.pdf", "JuniorChamps.pdf"]);
		expect(found[0]).toEqual({ attachmentId: "att-1", filename: "SummerComp.pdf", mimeType: "application/pdf", size: 84210 });
	});

	it("ignores an inline part with no filename — a logo is not an attachment", async () => {
		const { collectAttachments } = await import("./gmail.js");
		expect(collectAttachments(NESTED_MESSAGE.payload).some((a) => a.attachmentId === "att-logo")).toBe(false);
	});

	it("reports a filenamed part whose bytes are inline, with an empty id rather than dropping it", async () => {
		const { collectAttachments } = await import("./gmail.js");
		const found = collectAttachments({
			mimeType: "multipart/mixed",
			filename: "",
			parts: [{ mimeType: "text/csv", filename: "tiny.csv", body: { data: b64url("a,b") } }],
		});
		// Silently dropping it would make "that message has no attachments" a lie.
		expect(found).toEqual([{ attachmentId: "", filename: "tiny.csv", mimeType: "text/csv", size: 0 }]);
	});

	it("returns [] for an undefined payload", async () => {
		const { collectAttachments } = await import("./gmail.js");
		expect(collectAttachments(undefined)).toEqual([]);
	});
});

describe("getMessage", () => {
	const withFetch = async (payload: unknown, status = 200) => {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			calls.push(String(url));
			return new Response(JSON.stringify(payload), { status });
		}) as unknown as typeof fetch;
		return calls;
	};

	it("returns the body, the threading headers and the attachment manifest together", async () => {
		await withFetch(NESTED_MESSAGE);
		const { getMessage } = await import("./gmail.js");
		const msg = await getMessage("tok", "msg-1");
		expect(msg.threadId).toBe("thread-9");
		expect(msg.from).toBe("Kelly Cooper <str8.sets@bigpond.com>");
		// The reply path needs both of these, and neither was reachable before #711.
		expect(msg.messageId).toBe("<abc123@bigpond.com>");
		expect(msg.references).toBe("<root@bigpond.com>");
		expect(msg.text).toContain("returned by Sunday 30th August");
		expect(msg.attachments).toHaveLength(2);
	});

	it("surfaces Google's own reason on failure, not a bare status", async () => {
		await withFetch({ error: { message: "Request had insufficient authentication scopes." } }, 403);
		const { getMessage, GmailError } = await import("./gmail.js");
		await expect(getMessage("tok", "msg-1")).rejects.toThrow(GmailError);
		await expect(getMessage("tok", "msg-1")).rejects.toThrow(/insufficient authentication scopes/);
	});
});

describe("listMessages", () => {
	it("caps max at 25 and skips a message it cannot read rather than failing the search", async () => {
		const responses: Record<string, unknown> = {
			list: { messages: [{ id: "a" }, { id: "b" }] },
		};
		let listServed = false;
		const urls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			urls.push(String(url));
			if (!listServed) {
				listServed = true;
				return new Response(JSON.stringify(responses.list), { status: 200 });
			}
			// "a" reads fine; "b" 404s — a deleted message mid-search must not lose "a".
			if (String(url).includes("/messages/a")) return new Response(JSON.stringify(NESTED_MESSAGE), { status: 200 });
			return new Response("gone", { status: 404 });
		}) as unknown as typeof fetch;

		const { listMessages } = await import("./gmail.js");
		const hits = await listMessages("tok", "has:attachment", 500);
		expect(urls[0]).toContain("maxResults=25");
		expect(hits).toHaveLength(1);
		expect(hits[0].attachmentNames).toEqual(["SummerComp.pdf", "JuniorChamps.pdf"]);
	});

	it("returns [] without fetching any message when nothing matched", async () => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch;
		const { listMessages } = await import("./gmail.js");
		expect(await listMessages("tok", "from:nobody")).toEqual([]);
		expect(fetches).toBe(1);
	});
});

describe("base64UrlToBase64", () => {
	it("translates the alphabet and restores the padding atob requires", async () => {
		const { base64UrlToBase64 } = await import("./gmail.js");
		// Round-trips through atob, which is the only thing that has to accept the output.
		const original = "form?data>with/special+chars";
		const urlSafe = btoa(original).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(atob(base64UrlToBase64(urlSafe))).toBe(original);
	});

	it("leaves an already-padded, already-standard string alone", async () => {
		const { base64UrlToBase64 } = await import("./gmail.js");
		expect(base64UrlToBase64("YWJjZA==")).toBe("YWJjZA==");
	});
});
