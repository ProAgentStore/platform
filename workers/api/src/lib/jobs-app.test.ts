import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { JOBS_MCP_URL, callJobsTool, jobsAccountProblem } from "./jobs-app.js";
import { normalizeMcpEndpoint } from "./mcp-consent.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const who = { userId: "u1", instanceId: "scout" };
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["scout"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("Jobs account resolution (#1605)", () => {
	it("no grant is quiet; a grant without a connected account is named not_connected with the fix; a connected account clears it", async () => {
		expect(await jobsAccountProblem(env, who, "submit_leads")).toBeNull();
		d1.exec(`INSERT INTO instance_mcp_consent (instance_id, user_id, endpoint, tool) VALUES ('scout', 'u1', '${normalizeMcpEndpoint(JOBS_MCP_URL)}', 'submit_leads')`);
		const problem = await jobsAccountProblem(env, who, "submit_leads");
		expect(problem).toMatchObject({ ok: false, reason: "not_connected", detail: expect.stringContaining("Connect jobs.proappstore.online") });
		expect(await callJobsTool(env, who, "submit_leads", {})).toMatchObject({ ok: false, reason: "not_connected" });
		d1.exec(`INSERT INTO mcp_credentials (user_id, endpoint, account_id, auth_mode, key_ciphertext, dek_wrapped, iv) VALUES ('u1', '${normalizeMcpEndpoint(JOBS_MCP_URL)}', '', 'bearer', X'00', X'00', X'00')`);
		expect(await jobsAccountProblem(env, who, "submit_leads")).toBeNull();
	});
});
