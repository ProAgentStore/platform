import { describe, expect, it } from "vitest";
import worker from "./index";

function testEnv() {
	const requests: Request[] = [];
	const env = {
		API: {
			async fetch(input: Request | string) {
				const request = typeof input === "string" ? new Request(input) : input;
				requests.push(request.clone());
				return new Response("upstream", {
					status: 207,
					headers: { "X-Upstream-Url": request.url },
				});
			},
		},
	};
	return { env, requests };
}

describe("/admin/api proxy (#108)", () => {
	it("strips /admin/api, preserves query, and forwards the admin API request through the service binding", async () => {
		const { env, requests } = testEnv();
		const res = await worker.fetch(
			new Request("https://proagentstore.online/admin/api/v1/admin/users/u1/suspend?dry=1", {
				method: "POST",
				headers: {
					Authorization: "Bearer session-token",
					"Cf-Access-Jwt-Assertion": "access-jwt",
					"Content-Type": "application/json",
					"X-Do-Not-Forward": "private",
				},
				body: JSON.stringify({ reason: "test" }),
			}),
			env,
		);

		expect(res.status).toBe(207);
		expect(requests).toHaveLength(1);
		const upstream = requests[0];
		expect(upstream.url).toBe("https://api.proagentstore.online/v1/admin/users/u1/suspend?dry=1");
		expect(upstream.method).toBe("POST");
		expect(upstream.headers.get("Authorization")).toBe("Bearer session-token");
		expect(upstream.headers.get("Cf-Access-Jwt-Assertion")).toBe("access-jwt");
		expect(upstream.headers.get("Content-Type")).toBe("application/json");
		expect(upstream.headers.get("X-Do-Not-Forward")).toBeNull();
		expect(await upstream.text()).toBe(JSON.stringify({ reason: "test" }));
	});

	it("allows the exact non-admin paths the admin SPA needs", async () => {
		for (const path of ["/v1/auth/me", "/v1/auth/config", "/v1/errors/client"]) {
			const { env, requests } = testEnv();
			const res = await worker.fetch(new Request(`https://proagentstore.online/admin/api${path}`), env);

			expect(res.status, path).toBe(207);
			expect(requests[0].url, path).toBe(`https://api.proagentstore.online${path}`);
		}
	});

	it("does not proxy other API routes through the apex", async () => {
		const { env, requests } = testEnv();
		const res = await worker.fetch(new Request("https://proagentstore.online/admin/api/v1/agents"), env);

		expect(res.status).toBe(404);
		expect(requests).toHaveLength(0);
	});

	it("keeps the non-admin allowlist exact", async () => {
		const { env, requests } = testEnv();
		const res = await worker.fetch(new Request("https://proagentstore.online/admin/api/v1/auth/me/account"), env);

		expect(res.status).toBe(404);
		expect(requests).toHaveLength(0);
	});

	it("keeps non-GET methods rejected outside /admin/api", async () => {
		const { env, requests } = testEnv();
		const res = await worker.fetch(
			new Request("https://proagentstore.online/admin/users", {
				method: "POST",
				body: "{}",
			}),
			env,
		);

		expect(res.status).toBe(405);
		expect(requests).toHaveLength(0);
	});

	it("registers before the admin SPA deep-link fallback", async () => {
		const { env, requests } = testEnv();
		const res = await worker.fetch(new Request("https://proagentstore.online/admin/api/v1/admin/me"), env);

		expect(res.status).toBe(207);
		expect(await res.text()).toBe("upstream");
		expect(requests).toHaveLength(1);
	});
});
