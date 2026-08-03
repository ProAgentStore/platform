import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the shared executor so we can assert what each tool requests (and that it never runs live).
const { executeHttpRequest } = vi.hoisted(() => ({ executeHttpRequest: vi.fn() }));
vi.mock("./http.js", () => ({ executeHttpRequest }));

import { GOOGLE_SHEETS_CONNECTOR, GOOGLE_SHEETS_MANIFEST } from "./google-sheets.js";

const tool = (name: string) => {
	const t = GOOGLE_SHEETS_CONNECTOR.tools.find((x) => x.name === name);
	if (!t) throw new Error(`no tool ${name}`);
	return t;
};
const ctx = () => ({ env: {}, userId: "u1", instanceId: "i1", agentId: "i1" }) as never;

beforeEach(() => {
	executeHttpRequest.mockReset();
	executeHttpRequest.mockResolvedValue({ content: "{}", success: true });
});

describe("google_sheets connector (#89) — first oauth2 manifest", () => {
	it("compiles to an oauth connector carrying its OAuth config", () => {
		const c = GOOGLE_SHEETS_CONNECTOR;
		expect(c.id).toBe("google_sheets");
		expect(c.auth).toBe("oauth");
		expect(c.oauth).toMatchObject({
			authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			scopes: ["https://www.googleapis.com/auth/spreadsheets"],
			clientIdEnv: "GOOGLE_CLIENT_ID",
			secretEnv: "GOOGLE_CLIENT_SECRET",
		});
		// read + write tools; connector scopes derived from them.
		expect(c.tools.map((t) => t.name).sort()).toEqual(["sheets_append", "sheets_read"]);
		expect(tool("sheets_read").scope).toBe("read");
		expect(tool("sheets_append").scope).toBe("write");
		expect(c.scopes).toEqual({ read: true, write: true });
	});

	it("manifest declares clientIdEnv/secretEnv (built-in oauth creds, resolved server-side)", () => {
		expect(GOOGLE_SHEETS_MANIFEST.auth).toMatchObject({ type: "oauth2", clientIdEnv: "GOOGLE_CLIENT_ID" });
	});
});

describe("sheets_read", () => {
	it("GETs the URL-encoded range with responseMap 'values' + bearer auth on the sheets slot", async () => {
		await tool("sheets_read").handler(ctx(), { spreadsheetId: "abc123", range: "Sheet1!A1:D50" });
		const [, req, opts] = executeHttpRequest.mock.calls[0];
		expect(req).toMatchObject({ method: "GET", responseMap: "values", auth: { mode: "bearer" } });
		// encodeURIComponent encodes ":" (%3A) but leaves "!" — id + range are path-encoded.
		expect(String((req as { url: string }).url)).toBe("https://sheets.googleapis.com/v4/spreadsheets/abc123/values/Sheet1!A1%3AD50");
		expect(opts).toEqual({ connectorId: "google_sheets" });
	});

	it("rejects a missing range WITHOUT calling the executor", async () => {
		const r = await tool("sheets_read").handler(ctx(), { spreadsheetId: "abc" });
		expect(r.success).toBe(false);
		expect(executeHttpRequest).not.toHaveBeenCalled();
	});
});

describe("sheets_append", () => {
	it("POSTs {values: rows} to the :append endpoint with bearer auth", async () => {
		const rows = [["Noble Roasters", "Waterloo", "0491650017"]];
		await tool("sheets_append").handler(ctx(), { spreadsheetId: "abc123", range: "Sheet1!A:D", rows });
		const [, req, opts] = executeHttpRequest.mock.calls[0];
		expect(req).toMatchObject({ method: "POST", auth: { mode: "bearer" }, body: { values: rows } });
		expect(String((req as { url: string }).url)).toContain(":append?valueInputOption=USER_ENTERED");
		expect(opts).toEqual({ connectorId: "google_sheets" });
	});

	it("rejects when rows isn't an array (no dispatch)", async () => {
		const r = await tool("sheets_append").handler(ctx(), { spreadsheetId: "abc", range: "Sheet1!A:D", rows: "nope" });
		expect(r.success).toBe(false);
		expect(executeHttpRequest).not.toHaveBeenCalled();
	});
});
