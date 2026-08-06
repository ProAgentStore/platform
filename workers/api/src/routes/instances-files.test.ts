import { describe, expect, it } from "vitest";
import { parseFileKey } from "./instances-files.js";

// ── #217: the R2 key is the server's statement of what an upload is ──────────
describe("parseFileKey", () => {
	const inst = "inst-1";

	it("recovers the fileId and name that keyFor embedded", () => {
		expect(parseFileKey(inst, `agents/${inst}/files/abc-123/report.pdf`)).toEqual({ fileId: "abc-123", name: "report.pdf" });
	});

	// The bug: complete() read fileId/name from the BODY and checked only the key's prefix, so a
	// client could finish a legitimate upload and register it under any id — including one
	// already in use, silently repointing another file's metadata and orphaning its object.
	it("rejects a key belonging to another instance", () => {
		expect(parseFileKey(inst, "agents/other-instance/files/abc/report.pdf")).toBeNull();
	});

	it("rejects malformed keys rather than guessing", () => {
		expect(parseFileKey(inst, `agents/${inst}/files/`)).toBeNull();
		expect(parseFileKey(inst, `agents/${inst}/files/abc`)).toBeNull();
		expect(parseFileKey(inst, `agents/${inst}/files//report.pdf`)).toBeNull();
		expect(parseFileKey(inst, "")).toBeNull();
	});

	// keyFor sanitises the name at create time, so it never contains a slash. A key that does
	// was not produced by this API.
	it("rejects a nested or traversing name segment", () => {
		expect(parseFileKey(inst, `agents/${inst}/files/abc/sub/dir.pdf`)).toBeNull();
		expect(parseFileKey(inst, `agents/${inst}/files/../escape.pdf`)).toBeNull();
	});

	it("round-trips whatever keyFor produces", () => {
		const key = `agents/${inst}/files/${crypto.randomUUID()}/My File (1).txt`;
		const parsed = parseFileKey(inst, key);
		expect(parsed).not.toBeNull();
		expect(`agents/${inst}/files/${parsed!.fileId}/${parsed!.name}`).toBe(key);
	});
});
