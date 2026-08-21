import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationDedupeKey } from "../lib/notifications.js";
import type { Env } from "../types.js";
import { isSafePushEndpoint, notifyUser, sendPushToUser } from "./push.js";

const b64url = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A subscription with real P-256 keys so the encryption path actually runs. */
async function realSub(id: string) {
	const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	return {
		id,
		endpoint: `https://push.example/${id}`,
		p256dh: b64url(pub),
		auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
	};
}

async function vapidEnvKeys() {
	const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
	return { VAPID_PUBLIC_KEY: b64url(pub), VAPID_PRIVATE_KEY: jwk.d as string, VAPID_SUBJECT: "mailto:x@example.com" };
}

function mockEnv(subs: unknown[], extra: Record<string, unknown>): { env: Env; deletes: string[] } {
	const deletes: string[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							return { results: subs };
						},
						async run() {
							if (/DELETE/i.test(sql)) deletes.push(String(args[0]));
							return {};
						},
						async first() {
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB, ...extra } as unknown as Env, deletes };
}

afterEach(() => vi.unstubAllGlobals());

describe("isSafePushEndpoint (SSRF guard)", () => {
	it("accepts real public https push endpoints", () => {
		expect(isSafePushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
		expect(isSafePushEndpoint("https://web.push.apple.com/QABC")).toBe(true);
		expect(isSafePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
	});
	it("rejects non-https, private, internal, credentialed, and odd-port hosts", () => {
		for (const bad of [
			"http://fcm.googleapis.com/x",
			"https://localhost/x",
			"https://127.0.0.1/x",
			"https://10.0.0.5/x",
			"https://169.254.169.254/latest/meta-data/",
			"https://192.168.1.1/x",
			"https://172.16.0.1/x",
			"https://router.local/x",
			"https://internal/x",
			"https://[::1]/x",
			"https://user:pass@fcm.googleapis.com/x",
			"https://fcm.googleapis.com:8080/x",
			"ftp://example.com/x",
			"not a url",
		]) {
			expect(isSafePushEndpoint(bad), bad).toBe(false);
		}
	});
});

describe("sendPushToUser", () => {
	it("returns 0 and sends nothing when VAPID is not configured", async () => {
		const sub = await realSub("a");
		const { env } = mockEnv([sub], {});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await sendPushToUser(env, "u1", { title: "t", body: "b" })).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("delivers to every subscription on success", async () => {
		const subs = [await realSub("a"), await realSub("b")];
		const { env, deletes } = mockEnv(subs, await vapidEnvKeys());
		vi.stubGlobal("fetch", async () => new Response(null, { status: 201 }));
		expect(await sendPushToUser(env, "u1", { title: "t", body: "b" })).toBe(2);
		expect(deletes).toEqual([]);
	});

	it("prunes a subscription the push service reports gone (410)", async () => {
		const subs = [await realSub("dead")];
		const { env, deletes } = mockEnv(subs, await vapidEnvKeys());
		vi.stubGlobal("fetch", async () => new Response(null, { status: 410 }));
		expect(await sendPushToUser(env, "u1", { title: "t", body: "b" })).toBe(0);
		expect(deletes).toEqual(["dead"]);
	});
});

/**
 * A DB that answers the three reads `notifyUser` makes (preferences, duplicate probe, the
 * subscription list) and records every notification row written, so a test can assert the two
 * things that matter separately: did the ROW get written, and did the phone BUZZ.
 */
function notifyEnv(opts: { preferences?: unknown; duplicate?: boolean; subs?: unknown[] }) {
	const inserted: Array<Record<string, unknown>> = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							return { results: opts.subs ?? [] };
						},
						async run() {
							if (/INSERT INTO notifications/i.test(sql)) {
								inserted.push({ type: args[2], title: args[3], kind: args[7], dedupeKey: args[8], pushedAt: args[9] });
							}
							return {};
						},
						async first() {
							if (/SELECT preferences FROM users/i.test(sql)) {
								return { preferences: opts.preferences === undefined ? null : JSON.stringify(opts.preferences) };
							}
							if (/FROM notifications/i.test(sql)) return opts.duplicate ? { 1: 1 } : null;
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, inserted };
}

/**
 * The floor (#361). Every assertion here is "the row survived, the buzz did not" — the whole
 * design is that suppression is visible in the log rather than hidden the way the push `tag`
 * hid it in the OS tray.
 */
describe("notifyUser", () => {
	it("records the event key and the kind on the row", async () => {
		const { env, inserted } = notifyEnv({});
		await notifyUser(env, "u1", "deploy", "✅ Deployed", "live", "/console/", { key: "deploy:r1:abc" });
		expect(inserted).toHaveLength(1);
		expect(inserted[0].kind).toBe("update");
		expect(inserted[0].dedupeKey).toBe(notificationDedupeKey("deploy", "deploy:r1:abc", "✅ Deployed", "live"));
		expect(inserted[0].pushedAt).toBeTypeOf("string"); // it interrupted, so the window starts here
	});

	it("keeps the row but skips the push for a recent duplicate", async () => {
		const { env, inserted } = notifyEnv({ duplicate: true });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await notifyUser(env, "u1", "deploy", "✅ Deployed", "live", "/console/", { key: "deploy:r1:abc" });
		expect(inserted).toHaveLength(1); // the bell list is a LOG and stays complete
		expect(inserted[0].pushedAt).toBeNull(); // ...and this copy did not restart the window
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps the row but skips the push for a muted type", async () => {
		const { env, inserted } = notifyEnv({ preferences: { notifications: { muted: ["deploy"] } } });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await notifyUser(env, "u1", "deploy", "✅ Deployed", "live");
		expect(inserted[0].pushedAt).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// The one that must never regress: muting a type does not silence a run that has STOPPED
	// and is waiting for a human. Muting "Coder" stops "✅ Coder finished", never "🙋 needs you".
	it("still pushes an alert for a muted type", async () => {
		const subs = [await realSub("phone")];
		const { env, inserted } = notifyEnv({ preferences: { notifications: { muted: ["coding"] } }, subs });
		const envWithVapid = { ...(env as object), ...(await vapidEnvKeys()) } as unknown as Env;
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);
		await notifyUser(envWithVapid, "u1", "coding", "🙋 Coder needs you", "stuck", "/console/", { kind: "alert" });
		expect(inserted[0].kind).toBe("alert");
		expect(fetchSpy).toHaveBeenCalled();
	});

	// A notification must not be LOST because the floor could not be evaluated.
	it("falls open when the preference read throws", async () => {
		const subs = [await realSub("phone")];
		const broken = {
			DB: {
				prepare(sql: string) {
					if (/SELECT preferences/i.test(sql)) throw new Error("no such column");
					return {
						bind: () => ({
							all: async () => ({ results: subs }),
							run: async () => ({}),
							first: async () => null,
						}),
					};
				},
			},
			...(await vapidEnvKeys()),
		} as unknown as Env;
		const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);
		await notifyUser(broken, "u1", "deploy", "t", "b");
		expect(fetchSpy).toHaveBeenCalled();
	});
});

/**
 * The floor doing the job #709 stopped it doing.
 *
 * Four `coding_repos` rows point at `ProAgentStore/platform` — a repo is attached per workspace,
 * and that is a supported shape. The sweep is per row, so one push produced four notifyUser calls
 * 0.3–1.0 minutes apart, comfortably inside `DUPLICATE_WINDOW_MINUTES`. The floor never got the
 * chance to collapse them because the key carried the ROW id. Now it carries the repository.
 */
describe("notifyUser collapses one deploy reported by several workspaces (#709)", () => {
	/** Stateful, unlike `notifyEnv` above: the point is that the SECOND call sees the first. */
	function floorEnv() {
		const rows: Array<{ dedupeKey: unknown; pushedAt: unknown }> = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								return { results: [] };
							},
							async run() {
								if (/INSERT INTO notifications/i.test(sql)) rows.push({ dedupeKey: args[8], pushedAt: args[9] });
								return {};
							},
							async first() {
								if (/SELECT preferences FROM users/i.test(sql)) return { preferences: null };
								if (/FROM notifications/i.test(sql)) {
									const [, key, cutoff] = args as [string, string, string];
									const hit = rows.some(
										(r) => r.dedupeKey === key && typeof r.pushedAt === "string" && r.pushedAt > cutoff,
									);
									return hit ? { 1: 1 } : null;
								}
								return null;
							},
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, rows };
	}

	it("writes a row per workspace and interrupts exactly once", async () => {
		const { env, rows } = floorEnv();
		// One repository, one commit — and deliberately DIFFERENT prose, because each row's sweep
		// reads the page seconds apart and names a different subset of the workflows. That is why
		// the derived `title|body` fallback could never have collapsed these, and why the explicit
		// event key is the thing that has to be right.
		const key = "deploy:proagentstore/platform:sha:b91d340";
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "pags/platform is live — Deploy MCP Worker.", "/a", { key });
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "pags/platform is live — Deploy Host Worker.", "/b", { key });
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "ProAgentStore/platform is live — Deploy Host Worker, Deploy MCP Worker.", "/c", { key });
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "pags/platform is live — Deploy MCP Worker.", "/d", { key });

		// The bell list stays complete — it is a LOG, and each row keeps its own workspace link.
		expect(rows).toHaveLength(4);
		// ...but the phone buzzed once. Only the first copy restarts the window.
		expect(rows.filter((r) => typeof r.pushedAt === "string")).toHaveLength(1);
		expect(rows[0].pushedAt).toBeTypeOf("string");
	});

	// The guard against over-collapsing: a fork or mirror deploying the same commit is a different
	// repository, so its key differs and it still gets through.
	it("does not collapse two different repositories on the same commit", async () => {
		const { env, rows } = floorEnv();
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "live", "/a", { key: "deploy:acme/app:sha:b91d340" });
		await notifyUser(env, "u1", "deploy", "✅ Deployed b91d340", "live", "/b", { key: "deploy:acme/app-fork:sha:b91d340" });
		expect(rows.filter((r) => typeof r.pushedAt === "string")).toHaveLength(2);
	});
});
