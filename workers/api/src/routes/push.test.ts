import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { isSafePushEndpoint, sendPushToUser } from "./push.js";

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
	const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
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
