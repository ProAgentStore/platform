import { describe, expect, it } from "vitest";
import { type HttpsPushCapabilityProbe, pushCapabilityIssues, pushCapabilityRepos } from "./push-identity.js";

const probe = (over: Partial<HttpsPushCapabilityProbe> = {}): HttpsPushCapabilityProbe => ({
	checked: true,
	host: "github.com",
	identity: "sergey-ivochkin-rocketlab",
	repos: [],
	...over,
});

describe("pushCapabilityIssues (#1465)", () => {
	it("says nothing when the probe is unverified — absent, null, or an older runner", () => {
		expect(pushCapabilityIssues(undefined)).toEqual([]);
		expect(pushCapabilityIssues(null)).toEqual([]);
		expect(pushCapabilityIssues({ checked: false })).toEqual([]);
	});

	it("raises an error for a repo the resolved credential can read but not push to", () => {
		const out = pushCapabilityIssues(probe({ repos: [{ repo: "freeappstore-online/hanzi-associations", pushable: false }] }));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ severity: "error" });
		expect(out[0].message).toContain("sergey-ivochkin-rocketlab");
		expect(out[0].message).toContain("freeappstore-online/hanzi-associations");
		expect(out[0].message).toContain("cannot push to it");
	});

	it("names the mismatch when the push credential disagrees with gh's own login", () => {
		const out = pushCapabilityIssues(probe({ repos: [{ repo: "acme/repo", pushable: false }] }), "serge-ivo");
		expect(out[0].message).toMatch(/different account \(serge-ivo\)/);
		expect(out[0].fix).toContain("serge-ivo");
	});

	it("says nothing extra about identity when the push credential already matches gh's login", () => {
		const out = pushCapabilityIssues(probe({ identity: "serge-ivo", repos: [{ repo: "acme/repo", pushable: false }] }), "serge-ivo");
		expect(out[0].message).not.toMatch(/different account/);
	});

	it("raises nothing for a repo that IS pushable", () => {
		expect(pushCapabilityIssues(probe({ repos: [{ repo: "acme/repo", pushable: true }] }))).toEqual([]);
	});

	it("raises nothing for a repo that could not be verified — undetermined is not a finding", () => {
		expect(pushCapabilityIssues(probe({ repos: [{ repo: "acme/repo", pushable: null, reason: "could not be verified against the GitHub API" }] }))).toEqual([]);
	});

	it("reports one issue per unpushable repo, in order", () => {
		const out = pushCapabilityIssues(
			probe({
				repos: [
					{ repo: "acme/one", pushable: false },
					{ repo: "acme/two", pushable: true },
					{ repo: "acme/three", pushable: false },
				],
			}),
		);
		expect(out.map((i) => i.message.includes("acme/one") || i.message.includes("acme/three"))).toEqual([true, true]);
		expect(out).toHaveLength(2);
	});
});

describe("pushCapabilityRepos (#1465)", () => {
	it("extracts only the GitHub slug, deduplicated", () => {
		expect(
			pushCapabilityRepos([{ githubRepo: "acme/one" }, { githubRepo: "acme/two" }, { githubRepo: "acme/one" }]),
		).toEqual(["acme/one", "acme/two"]);
	});

	it("drops a repo with no GitHub slug — a local-only checkout has nothing to probe", () => {
		expect(pushCapabilityRepos([{ githubRepo: "acme/one" }, { githubRepo: null }, { githubRepo: undefined }, {}])).toEqual(["acme/one"]);
	});

	it("is empty for an instance with no GitHub-backed repos at all", () => {
		expect(pushCapabilityRepos([])).toEqual([]);
		expect(pushCapabilityRepos([{ githubRepo: undefined }])).toEqual([]);
	});
});
