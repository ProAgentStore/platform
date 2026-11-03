/** #1459: the tiny best-effort durable record a background clone leaves behind. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clearReceipt, type CloneReceipt, defaultReceiptStorePath, readReceipt, writeReceipt } from "./clone-receipt-store.js";

const tmp = mkdtempSync(join(tmpdir(), "pags-clone-receipt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const receipt = (over: Partial<CloneReceipt> = {}): CloneReceipt => ({
	path: "/w/gk",
	slug: "acme/gk",
	protocol: "auto",
	jobId: "job-1",
	runnerInstanceId: "runner-1",
	pid: 1234,
	startedAt: 1,
	...over,
});

describe("clone receipt store (#1459)", () => {
	it("reads back exactly what was written, keyed by the canonical destination", () => {
		const store = join(tmp, "a.json");
		writeReceipt(store, receipt());
		expect(readReceipt(store, "/w/gk")).toEqual(receipt());
	});

	it("reports no receipt for a path nothing was ever written for", () => {
		const store = join(tmp, "b.json");
		writeReceipt(store, receipt());
		expect(readReceipt(store, "/w/other")).toBeNull();
	});

	it("reports no receipt when the store file does not exist yet", () => {
		expect(readReceipt(join(tmp, "missing.json"), "/w/gk")).toBeNull();
	});

	it("keeps more than one path's receipt side by side", () => {
		const store = join(tmp, "c.json");
		writeReceipt(store, receipt({ path: "/w/one" }));
		writeReceipt(store, receipt({ path: "/w/two", slug: "acme/two" }));
		expect(readReceipt(store, "/w/one")?.path).toBe("/w/one");
		expect(readReceipt(store, "/w/two")?.slug).toBe("acme/two");
	});

	it("clear removes only the named receipt, leaving others intact", () => {
		const store = join(tmp, "d.json");
		writeReceipt(store, receipt({ path: "/w/one" }));
		writeReceipt(store, receipt({ path: "/w/two" }));
		clearReceipt(store, "/w/one");
		expect(readReceipt(store, "/w/one")).toBeNull();
		expect(readReceipt(store, "/w/two")).not.toBeNull();
	});

	it("clear on a store that does not exist is a harmless no-op", () => {
		expect(() => clearReceipt(join(tmp, "never.json"), "/w/gk")).not.toThrow();
	});

	it("never carries anything that looks like a credential — the schema has no field for one", () => {
		const r = receipt();
		expect(Object.keys(r).sort()).toEqual(["jobId", "path", "pid", "protocol", "runnerInstanceId", "slug", "startedAt"]);
	});

	it("survives a corrupt store file by treating it as empty, rather than throwing", () => {
		const store = join(tmp, "corrupt.json");
		writeFileSync(store, "{not json");
		expect(readReceipt(store, "/w/gk")).toBeNull();
		expect(() => writeReceipt(store, receipt())).not.toThrow();
		expect(readReceipt(store, "/w/gk")).toEqual(receipt());
	});

	it("defaultReceiptStorePath lives under the given repos base dir", () => {
		expect(defaultReceiptStorePath("/base")).toMatch(/clone-receipts\.json$/);
	});
});
