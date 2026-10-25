import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cliPackument, compareVersions, missingForVersion, observed, previousRelease } from "./lib.mjs";

describe("previousRelease (#1152)", () => {
	it("is the newest published version strictly older than the candidate", () => {
		expect(previousRelease(["0.4.9", "0.4.10", "0.4.178", "0.4.179", "0.4.181"], "0.4.180")).toBe("0.4.179");
		expect(previousRelease(["0.4.9", "0.4.10"], "0.4.11")).toBe("0.4.10"); // numeric, not lexical
	});
	it("ignores the candidate itself, newer ones and anything that is not a plain version", () => {
		expect(previousRelease(["0.4.180", "0.5.0", "0.4.180-beta.1", "latest"], "0.4.180")).toBeNull();
		expect(previousRelease([], "0.4.1")).toBeNull();
	});
	it("compares plain versions only", () => {
		expect(compareVersions("0.4.2", "0.4.10")).toBe(-1);
		expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0-rc", "1.0.0")).toBeNull();
	});
});

describe("cliPackument", () => {
	const tarball = Buffer.from("tarball bytes");
	const candidate = { name: "@proagentstore/cli", version: "0.4.180", bin: { pags: "dist/bootstrap.js" }, dependencies: { commander: "^13.0.0" } };
	const previous = { name: "@proagentstore/cli", version: "0.4.179", dist: { tarball: "https://registry.npmjs.org/x.tgz", shasum: "abc" } };
	it("serves the candidate as latest, with a tarball URL on the fake and checksums npm will verify", () => {
		const p = cliPackument({ name: "@proagentstore/cli", candidate, tarball, tarballUrl: "http://127.0.0.1:1/-/candidate.tgz", previous });
		expect(p["dist-tags"]).toEqual({ latest: "0.4.180" });
		const dist = p.versions["0.4.180"].dist;
		expect(dist.tarball).toBe("http://127.0.0.1:1/-/candidate.tgz");
		expect(dist.shasum).toBe(createHash("sha1").update(tarball).digest("hex"));
		expect(dist.integrity).toBe(`sha512-${createHash("sha512").update(tarball).digest("base64")}`);
		expect(p.versions["0.4.180"].dependencies).toEqual({ commander: "^13.0.0" });
	});
	it("keeps the previous release exactly as the real registry described it, and works without one", () => {
		const p = cliPackument({ name: "@proagentstore/cli", candidate, tarball, tarballUrl: "u", previous });
		expect(p.versions["0.4.179"]).toBe(previous);
		expect(Object.keys(cliPackument({ name: "n", candidate, tarball, tarballUrl: "u", previous: null }).versions)).toEqual(["0.4.180"]);
	});
});

describe("what the fake platform saw", () => {
	const reg = (seq, runnerVersion) => ({ seq, method: "POST", path: "/v1/instances/i1/runtime", body: { runnerVersion } });
	const beat = (seq) => ({ seq, method: "POST", path: "/v1/instances/i1/runtime/heartbeat", body: {} });
	it("a version is alive once it has registered AND heartbeated after registering", () => {
		expect(missingForVersion([reg(0, "0.4.180"), beat(1)], "0.4.180")).toBeNull();
	});
	it("says what is missing: nothing registered, or no heartbeat after the registration", () => {
		expect(missingForVersion([], "0.4.180")).toMatch(/no runtime registration from 0\.4\.180 \(saw: none\)/);
		expect(missingForVersion([reg(0, "0.4.179"), beat(1)], "0.4.180")).toMatch(/saw: 0\.4\.179/);
		expect(missingForVersion([reg(0, "0.4.180")], "0.4.180")).toMatch(/has not heartbeated/);
		// a heartbeat from BEFORE it registered (the previous process) does not count
		expect(missingForVersion([beat(0), reg(1, "0.4.180")], "0.4.180")).toMatch(/has not heartbeated/);
	});
	it("ignores other paths and other methods", () => {
		const o = observed([{ seq: 0, method: "GET", path: "/v1/instances/i1/runtime", body: {} }, { seq: 1, method: "POST", path: "/v1/errors/runner-crashes", body: {} }]);
		expect(o.registrations).toEqual([]);
		expect(o.heartbeats).toEqual([]);
	});
});
