import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { sendPushToUser } from "./push.js";

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
