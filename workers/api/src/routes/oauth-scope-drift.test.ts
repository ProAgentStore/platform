/**
 * A live OAuth flow must ask for everything its manifest declares (#717; one flow since #352 Stage 2).
 *
 * THE DEFECT THIS EXISTS FOR. Three connectors do not connect through the generic
 * `/v1/connectors/:id/oauth/start` — their OAuth apps register `/v1/{drive,email}/google/callback`
 * instead — so `DEDICATED_FLOWS` in `routes/connectors.ts` pins each to a bespoke route that
 * builds its own authorize URL. That leaves TWO lists of scopes per connector: the manifest, which
 * `GET /v1/connectors` reports and `missingScopesFor` diffs a stored grant against, and the string
 * the live route actually sends to the provider. #716 added `gmail.modify` to the manifest and
 * `git show c7c1adae -- workers/api/src/routes/email.ts` was empty, so only one list moved.
 *
 * The consequence was not cosmetic. `gmail_archive` and `gmail_mark_read` could never succeed for
 * anybody — Google was never asked for the scope, so no grant could hold it — while every
 * connected Gmail account rendered as permanently short of scope, asking for a reconnect that
 * could not clear it. `lib/connectors/gmail.test.ts` asserted the manifest contained the scope;
 * nothing asserted the ask did.
 *
 * WHAT IS ASSERTED. The authorize URL each dedicated start route returns requests a SUPERSET of
 * its manifest's declared scopes. Superset, not equality: a route may legitimately ask for more
 * than the catalog describes (a provider-specific extra), but never less — less is a capability
 * declared to owners that no consent can grant.
 *
 * The flows are ENUMERATED from `GET /v1/connectors`, which is the server's own statement of which
 * flow is live, rather than named here. So a fourth dedicated flow is covered the day it is added,
 * and #352 Stage 2 deleting one is covered by the list simply getting shorter. If a dedicated start
 * path is not routable on the app below the test FAILS rather than skipping — an unmountable flow
 * is a flow nobody is guarding.
 *
 * Pure unit test: no network, no browser, no socket. The only mock is session verification.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/session.js", () => ({
	verifySession: async (t: string) => (t ? { uid: "u1", roles: [] } : null),
}));

import { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { getConnector } from "../lib/connectors/registry.js";
import { connectorRoutes } from "./connectors.js";
import { driveRoutes } from "./drive.js";
import { emailRoutes } from "./email.js";
import { workdriveRoutes } from "./workdrive.js";
import type { Env } from "../types.js";

// The same prefixes index.ts mounts these at, so a `flow.start` path from the catalog resolves
// here exactly as it does in production.
const app = new Hono<{ Bindings: Env }>();
app.route("/v1/connectors", connectorRoutes);
app.route("/v1/email", emailRoutes);
app.route("/v1/drive", driveRoutes);
app.route("/v1/workdrive", workdriveRoutes);
app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));

const env = () =>
	({
		SESSION_SIGNING_KEY: "signing-key",
		GOOGLE_CLIENT_ID: "google-client",
		GOOGLE_CLIENT_SECRET: "google-secret",
		ZOHO_CLIENT_ID: "zoho-client",
		ZOHO_CLIENT_SECRET: "zoho-secret",
		DB: {
			prepare: () => ({
				bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }),
			}),
		},
	}) as unknown as Env;

const authed = { headers: { Authorization: "Bearer tok" } };

/** Every connector's LIVE connect flow, as the server states it. */
async function liveFlows(): Promise<Array<{ id: string; start: string }>> {
	const res = await app.request("/v1/connectors", authed, env());
	expect(res.status).toBe(200);
	const { connectors } = (await res.json()) as Array<never> & {
		connectors: Array<{ id: string; flow: { start: string } | null }>;
	};
	return connectors.filter((c) => c.flow).map((c) => ({ id: c.id, start: c.flow!.start }));
}

/** The `scope` parameter of the authorize URL a start route hands the browser. */
async function requestedScopes(start: string): Promise<string[]> {
	const res = await app.request(start, authed, env());
	expect(res.status, `${start} did not answer 200 — is its route mounted in this test?`).toBe(200);
	const { url } = (await res.json()) as { url: string };
	return (new URL(url).searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
}

describe("every live OAuth flow asks for what its manifest declares", () => {
	// #352 Stage 2 retired the last dedicated flow. The drift this file was written for needed TWO
	// lists of scopes — the manifest, and a bespoke route's own string — and there is now one flow
	// reading one list. The guard is kept, inverted: a dedicated flow coming back fails here first.
	it("no connector has a dedicated flow any more — every live flow is the generic route", async () => {
		const flows = await liveFlows();
		expect(flows.map((f) => f.id)).toEqual(expect.arrayContaining(["gmail", "google_drive", "zoho_workdrive"]));
		expect(flows.filter((f) => !f.start.startsWith("/v1/connectors/"))).toEqual([]);
	});

	it("requests a superset of every declared scope, for every live flow", async () => {
		for (const flow of await liveFlows()) {
			const declared = getConnector(flow.id)?.oauth?.scopes ?? [];
			const requested = new Set(await requestedScopes(flow.start));
			const notAsked = declared.filter((s) => !requested.has(s));
			expect(notAsked, `${flow.id}: declared in the manifest but never requested by ${flow.start}`).toEqual([]);
		}
	});

	// The specific regression, named so a failure reads as itself rather than as a loop index.
	it("a plain Gmail connect asks for read-only; choosing every optional grant asks for send AND modify (#716, #717, #718)", async () => {
		const plain = await requestedScopes("/v1/connectors/gmail/oauth/start");
		expect(plain).toContain("https://www.googleapis.com/auth/gmail.readonly");
		expect(plain).not.toContain("https://www.googleapis.com/auth/gmail.send");
		expect(plain).not.toContain("https://www.googleapis.com/auth/gmail.modify");
		// Every optional grant the manifest offers is reachable through the live route — the #717 lesson,
		// now for the optional list: a declared power no consent can grant is the same defect.
		const all = await requestedScopes("/v1/connectors/gmail/oauth/start?grant=send&grant=modify");
		for (const g of getConnector("gmail")?.oauth?.optionalGrants ?? []) for (const s of g.scopes) expect(all).toContain(s);
		expect(all).toContain("https://www.googleapis.com/auth/gmail.send");
		expect(all).toContain("https://www.googleapis.com/auth/gmail.modify");
	});

	// Permanent deletion needs `https://mail.google.com/`. Nothing in this codebase requests it and
	// no tool could use it; the bound on the blast radius of gmail.modify is that it stays that way.
	it("never asks for full-mailbox access, which is what permanent deletion would need", async () => {
		const requested = await requestedScopes("/v1/connectors/gmail/oauth/start");
		expect(requested).not.toContain("https://mail.google.com/");
	});

	it("Google Drive asks for the read scope its manifest declares", async () => {
		const requested = await requestedScopes("/v1/drive/google/start");
		expect(requested).toContain("https://www.googleapis.com/auth/drive.readonly");
	});
});
