/**
 * Reference implementation of the worker-backed email adapter contract (#1269,
 * platform-docs/email-worker-adapter.md). This is the "test fixture" the issue asks for: a
 * customer standing up their own Worker can read this file end-to-end as a minimal, correct
 * implementation of every call PAGS makes, with no dependency on a PAGS-hosted mailbox.
 *
 * It is also what this platform's own tests drive against (email-worker.test.ts) — the same
 * fixture, not a second hand-rolled stub, so a change to the contract that this fixture gets
 * wrong is a change the tests would get wrong identically.
 */

export interface FixtureMessage {
	id: string;
	threadId: string;
	from: string;
	to: string;
	cc?: string;
	subject: string;
	date: string;
	body: string;
	snippet?: string;
}

export interface EmailWorkerFixtureOptions {
	/** The bearer secret this fixture requires. A mismatch answers 401, like a real adapter. */
	secret: string;
	contractVersion?: string;
	address?: string;
	messages?: FixtureMessage[];
	/** Force every call to answer 500 — for exercising the retry path. */
	forceServerError?: boolean;
}

function errorBody(code: string, message: string): string {
	return JSON.stringify({ error: { code, message } });
}

/**
 * Build a `fetch`-compatible handler implementing the contract over an in-memory mailbox. Wire
 * it to `vi.stubGlobal("fetch", ...)` in a test, or run it as an actual Worker for local manual
 * testing — the function takes a `Request` and returns a `Response` either way.
 */
export function createEmailWorkerFixture(opts: EmailWorkerFixtureOptions): (req: Request | string, init?: RequestInit) => Promise<Response> {
	const messages = new Map((opts.messages ?? []).map((m) => [m.id, m]));
	const seenIdempotencyKeys = new Map<string, Response>();
	let nextId = messages.size + 1;

	return async (input, init) => {
		const req = input instanceof Request ? input : new Request(input, init);
		const url = new URL(req.url);
		const auth = req.headers.get("authorization") ?? "";
		if (auth !== `Bearer ${opts.secret}`) return new Response(errorBody("unauthorized", "Bad credential"), { status: 401 });
		if (opts.forceServerError) return new Response(errorBody("internal", "Simulated outage"), { status: 500 });

		const body = req.method === "POST" ? ((await req.clone().json().catch(() => ({}))) as Record<string, unknown>) : {};

		if (url.pathname.endsWith("/identity")) {
			return Response.json({ contractVersion: opts.contractVersion ?? "email-worker/v1", account: { address: opts.address ?? null } });
		}

		if (url.pathname.endsWith("/messages/list")) {
			const limit = typeof body.limit === "number" ? body.limit : 10;
			const list = [...messages.values()].slice(0, limit).map((m) => ({ id: m.id, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, date: m.date, snippet: m.snippet ?? m.body.slice(0, 80), hasAttachments: false }));
			return Response.json({ messages: list, nextCursor: null });
		}

		if (url.pathname.endsWith("/messages/get")) {
			const id = typeof body.id === "string" ? body.id : "";
			const msg = messages.get(id);
			if (!msg) return new Response(errorBody("not_found", `No message ${id}`), { status: 404 });
			return Response.json({ ...msg, attachments: [] });
		}

		if (url.pathname.endsWith("/messages/send") || url.pathname.endsWith("/messages/reply")) {
			const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
			if (key && seenIdempotencyKeys.has(key)) return seenIdempotencyKeys.get(key)!.clone();

			let threadId: string;
			if (url.pathname.endsWith("/messages/reply")) {
				const parent = messages.get(typeof body.messageId === "string" ? body.messageId : "");
				if (!parent) return new Response(errorBody("not_found", "No such message to reply to"), { status: 404 });
				threadId = parent.threadId;
			} else {
				threadId = `thread-${nextId}`;
			}
			const id = `msg-${nextId++}`;
			messages.set(id, { id, threadId, from: opts.address ?? "me@example.com", to: typeof body.to === "string" ? body.to : "", subject: typeof body.subject === "string" ? body.subject : "Re:", date: new Date().toISOString(), body: typeof body.body === "string" ? body.body : "" });
			const res = Response.json({ id, threadId });
			if (key) seenIdempotencyKeys.set(key, res.clone());
			return res;
		}

		return new Response(errorBody("not_found", `No such endpoint: ${url.pathname}`), { status: 404 });
	};
}
