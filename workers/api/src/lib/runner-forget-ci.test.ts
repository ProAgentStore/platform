/** #1211 — the forget preflight names the CI runners a forget would orphan on GitHub. */
import { describe, expect, it } from "vitest";
import { ciRunnersForForget, labelsForNames } from "./runner-forget-ci.js";

const runner = (id: number, name: string, labels: string[], over: Record<string, unknown> = {}) => ({ id, name, status: "offline", busy: false, labels: labels.map((n) => ({ name: n })), ...over });

function gh(byOrg: Record<string, unknown>, status: Record<string, number> = {}) {
	return {
		installationToken: async (org: string) => (org === "noapp" ? null : "ghs"),
		fetch: async (url: string) => {
			const org = /orgs\/([^/]+)\//.exec(url)?.[1] ?? "";
			return status[org] ? new Response("{}", { status: status[org] }) : Response.json({ runners: byOrg[org] ?? [] });
		},
	};
}

describe("labelsForNames", () => {
	it("is the routing label of every name the machine has used, skipping unusable ones", () => {
		expect(labelsForNames(["Sergeys-Mac-mini.local", "mac-mini", ""])).toEqual(["pags-sergeys-mac-mini-local", "pags-mac-mini"]);
	});
});

describe("the CI runners a forget would orphan", () => {
	it("lists the runners carrying the machine's label, in every org, and none carrying another machine's", async () => {
		const r = await ciRunnersForForget(["mac-mini"], ["proappstore-online", "pas-apps"], gh({ "proappstore-online": [runner(1, "mac-mini-a", ["self-hosted", "pags", "pags-mac-mini"], { status: "online", busy: true }), runner(2, "dell-a", ["self-hosted", "pags-dell"])], "pas-apps": [runner(3, "mac-mini-b", ["pags-mac-mini"])] }));
		expect(r.runners).toEqual([
			{ org: "proappstore-online", id: 1, name: "mac-mini-a", status: "online", busy: true },
			{ org: "pas-apps", id: 3, name: "mac-mini-b", status: "offline", busy: false },
		]);
		expect(r.unreadable).toEqual([]);
	});

	it("an org the App cannot read is named with why — not skipped, and not a failure", async () => {
		const r = await ciRunnersForForget(["mac-mini"], ["a", "noapp", "b"], gh({ a: [runner(1, "x", ["pags-mac-mini"])] }, { b: 403 }));
		expect(r.runners).toHaveLength(1);
		expect(r.unreadable).toEqual([{ org: "noapp", detail: expect.stringMatching(/not installed/) }, { org: "b", detail: expect.stringMatching(/Self-hosted runners.*#1207/) }]);
	});

	it("a machine name with no usable label asks GitHub nothing", async () => {
		let asked = 0;
		const d = { installationToken: async () => "t", fetch: async () => {
				asked++;
				return Response.json({});
			},
		};
		expect(await ciRunnersForForget([""], ["o"], d)).toEqual({ runners: [], unreadable: [] });
		expect(asked).toBe(0);
	});
});
