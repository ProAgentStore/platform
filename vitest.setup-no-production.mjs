/**
 * No test reaches production (#1120).
 *
 * The SDK's error reporter posts to the hard-coded production API (`packages/sdk/src/client.ts`), and
 * since #1088 its outbox starts as soon as it is imported somewhere browser-like. Nothing stopped a
 * test from sending a real row: on 2026-10-16 the production log held `client:undefined` / "undefined"
 * and a `client:voice-config` row a second later, both `build: "unset"` and unattributed — the shape a
 * test run leaves, since no test declares a build. The sender was never reproduced. A full suite run
 * with every `*.proagentstore.online` request recorded found none at the commit that added this guard.
 * The guard makes that true from now on, not just measured once.
 *
 * Every request to a `*.proagentstore.online` host is refused WITHOUT being sent, answered 599, and the
 * test that made it fails, naming the URL. A request made while a module loads, outside any test,
 * fails the next test to run. A test that stubs `fetch` replaces this wrapper and is unaffected. The
 * wrapper is installed at load, before any test file is imported, so an outbox that sends on import is
 * caught too.
 */
import { afterEach, expect } from "vitest";

const PRODUCTION = /^https?:\/\/([a-z0-9-]+\.)*proagentstore\.online(?::\d+)?(\/|$)/i;
const realFetch = globalThis.fetch;
/** Production requests not yet charged to a test: `{ url, test }`. */
const caught = [];

if (typeof realFetch === "function") {
	globalThis.fetch = function noProduction(input, init) {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
		if (PRODUCTION.test(url)) {
			let test = "(outside any test — while a module loaded)";
			try {
				test = expect.getState().currentTestName ?? test;
			} catch {
				// No test is running.
			}
			caught.push({ url, test });
			return Promise.resolve(new Response(JSON.stringify({ error: "a test may not reach production (vitest.setup-no-production.mjs)" }), { status: 599, headers: { "Content-Type": "application/json" } }));
		}
		return realFetch.call(this, input, init);
	};
}

afterEach(() => {
	if (!caught.length) return;
	const calls = caught.splice(0).map((c) => `${c.url} — ${c.test}`).join("\n  ");
	throw new Error(`A test reached for production (#1120). Stub fetch, or route the call to a fake:\n  ${calls}`);
});
