import { describe, expect, it } from "vitest";
import { REMOTE_AUTH_STATES as WORKER_STATES } from "../../../../workers/api/src/lib/remote-auth";
import { REMOTE_AUTH_STATES, buildRelayBody } from "./remote-auth.js";

const ME = { id: "m-1", node: "mac-mini" };
const PUBLIC = {
	request_id: "req_AbCdEfGhIjKlMnOpQrStUv",
	agent: { id: "codex", label: "Codex" },
	machine: { id: "mac-42", label: "Remote Mac" },
	resource: "https://mcp.proappstore.online/mcp",
	scopes: [],
	approval_url: "https://api.proappstore.online/v1/mcp/broker/v2/requests/req_AbCdEfGhIjKlMnOpQrStUv/approve",
	expires_at: "2026-10-13T00:10:00Z",
	status_url: "https://api.proappstore.online/status",
};

describe("pags remote-auth relay (#1005)", () => {
	it("relays only the public request fields, with this machine's PAGS identity", () => {
		expect(buildRelayBody(PUBLIC, ME)).toEqual({ ok: true, body: { ...Object.fromEntries(Object.entries(PUBLIC).filter(([k]) => k !== "status_url")), relayed_by: { node: "mac-mini", machine_id: "m-1" } } });
	});

	it.each(["code_verifier", "machine_proof", "machine_private_key", "token", "access_token", "session", "ciphertext", "code"])("refuses a request carrying %s — at any depth — before anything is sent", (key) => {
		expect(buildRelayBody({ ...PUBLIC, [key]: "x" }, ME)).toMatchObject({ ok: false, error: expect.stringContaining(key) });
		expect(buildRelayBody({ ...PUBLIC, machine: { ...PUBLIC.machine, [key]: "x" } }, ME)).toMatchObject({ ok: false });
	});

	it("refuses anything that is not a JSON object", () => {
		expect(buildRelayBody([], ME).ok).toBe(false);
		expect(buildRelayBody("req", ME).ok).toBe(false);
	});

	it("knows exactly the states the Worker accepts", () => {
		expect([...REMOTE_AUTH_STATES]).toEqual([...WORKER_STATES]);
	});
});
