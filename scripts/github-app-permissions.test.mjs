import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { comparePermissions, formatReport, meets, missingPermissions, readState, REQUIRED_APP_PERMISSIONS } from "./lib/github-app-permissions.mjs";

const COMPLETE = Object.fromEntries(Object.entries(REQUIRED_APP_PERMISSIONS).map(([k, v]) => [k, v.level]));
const BEFORE = { actions: "read", contents: "read", issues: "write", members: "read", metadata: "read" }; // the App on 2026-10-19
const NOW_APP = { ...BEFORE, organization_self_hosted_runners: "write" }; // as read on 2026-10-26

describe("the required permissions (#1207)", () => {
	it("are the five the platform already used plus the three the runner work needs", () => {
		expect(Object.keys(REQUIRED_APP_PERMISSIONS)).toEqual(["actions", "contents", "issues", "members", "metadata", "organization_self_hosted_runners", "actions_variables", "organization_administration"]);
		expect(REQUIRED_APP_PERMISSIONS.organization_self_hosted_runners.level).toBe("write");
		expect(REQUIRED_APP_PERMISSIONS.actions_variables.level).toBe("write");
		expect(REQUIRED_APP_PERMISSIONS.organization_administration.level).toBe("read");
	});
});

describe("meets / missingPermissions", () => {
	it("admin satisfies write satisfies read; an absent or unknown level satisfies nothing", () => {
		expect(meets("admin", "write")).toBe(true);
		expect(meets("write", "read")).toBe(true);
		expect(meets("read", "write")).toBe(false);
		expect(meets(undefined, "read")).toBe(false);
		expect(meets("bogus", "read")).toBe(false);
	});

	it("names every missing permission, what the App holds of it, and why it is needed", () => {
		const m = missingPermissions({ ...NOW_APP, actions: "read" });
		expect(m.map((x) => x.key)).toEqual(["actions_variables", "organization_administration"]);
		expect(m[0]).toMatchObject({ required: "write", held: null, why: expect.stringContaining("PAGS_RUNNER") });
	});

	it("a permission held at too LOW a level is missing, and says what is held", () => {
		expect(missingPermissions({ ...COMPLETE, issues: "read" })).toEqual([expect.objectContaining({ key: "issues", required: "write", held: "read" })]);
	});

	it("a higher level than required is fine; nothing held means everything is missing", () => {
		expect(missingPermissions({ ...COMPLETE, actions: "write" })).toEqual([]);
		expect(missingPermissions(null)).toHaveLength(Object.keys(REQUIRED_APP_PERMISSIONS).length);
	});
});

describe("comparePermissions / formatReport", () => {
	it("the state read on 2026-10-26: the App lacks two, one org accepted the runner permission, the other none of the new ones", () => {
		const r = comparePermissions({
			app: { permissions: NOW_APP },
			installations: [
				{ org: "ProAgentStore", permissions: { actions: "read", contents: "read", issues: "write", metadata: "read" } },
				{ org: "proappstore-online", permissions: NOW_APP },
			],
		});
		expect(r.ok).toBe(false);
		expect(r.app.map((m) => m.key)).toEqual(["actions_variables", "organization_administration"]);
		expect(r.orgs[0].missing.map((m) => m.key)).toEqual(["members", "organization_self_hosted_runners", "actions_variables", "organization_administration"]);
		expect(r.orgs[1].missing.map((m) => m.key)).toEqual(["actions_variables", "organization_administration"]);
		const text = formatReport(r);
		expect(text).toContain("✗ The App's configured permissions are missing");
		expect(text).toContain("actions_variables: needs write, not granted");
		expect(text).toContain("https://github.com/organizations/ProAgentStore/settings/installations");
		expect(text).toContain("Not satisfied yet.");
	});

	it("complete everywhere is ok", () => {
		const r = comparePermissions({ app: { permissions: COMPLETE }, installations: [{ org: "a", permissions: COMPLETE }] });
		expect(r.ok).toBe(true);
		expect(formatReport(r)).toContain("All permissions are granted and accepted.");
	});

	it("an installation or App that cannot be read is NOT confirmed — never read as fine", () => {
		expect(comparePermissions({ app: { permissions: COMPLETE }, installations: [{ org: "a", error: "403" }] }).ok).toBe(false);
		const r = comparePermissions({ app: { error: "network" }, installations: [] });
		expect(r.ok).toBe(false);
		expect(formatReport(r)).toContain("could not be read");
		expect(formatReport(comparePermissions({ app: { permissions: COMPLETE }, installations: [{ org: "a", error: "403" }] }))).toContain("NOT confirmed");
	});
});

describe("readState", () => {
	it("reads the App and picks this App's installation out of an org's list", async () => {
		const get = async (p) => {
			if (p === "/apps/proagentstore") return { permissions: NOW_APP };
			if (p === "/orgs/o/installations") return { installations: [{ app_slug: "other", permissions: {} }, { app_slug: "proagentstore", permissions: BEFORE }] };
			throw new Error("not found");
		};
		expect(await readState(get, ["o"])).toEqual({ app: { permissions: NOW_APP }, installations: [{ org: "o", permissions: BEFORE }] });
	});

	it("not installed, and a refused read, are errors on that org — the others are still read", async () => {
		const get = async (p) => {
			if (p === "/apps/proagentstore") return { permissions: COMPLETE };
			if (p === "/orgs/none/installations") return { installations: [] };
			if (p === "/orgs/denied/installations") throw new Error("HTTP 403\nsecond line");
			return { installations: [{ app_slug: "proagentstore", permissions: COMPLETE }] };
		};
		const s = await readState(get, ["none", "denied", "fine"]);
		expect(s.installations[0].error).toMatch(/not installed on none/);
		expect(s.installations[1].error).toBe("HTTP 403");
		expect(s.installations[2].permissions).toEqual(COMPLETE);
	});
});

describe("the script, with a fake gh on PATH", () => {
	const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const run = (app, installs) => {
		writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$2" in\n/apps/proagentstore) echo '${JSON.stringify({ permissions: app })}';;\n/orgs/*/installations) echo '${JSON.stringify({ installations: installs })}';;\n*) echo "HTTP 404" >&2; exit 1;;\nesac\n`);
		chmodSync(join(dir, "gh"), 0o755);
		return spawnSync(process.execPath, [join(import.meta.dirname, "check-github-app-permissions.mjs"), "o"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
	};

	it("exits 1 and prints the diff while anything is missing", () => {
		const r = run(NOW_APP, [{ app_slug: "proagentstore", permissions: NOW_APP }]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("organization_administration: needs read, not granted");
		expect(r.stdout).toContain("Not satisfied yet.");
	});

	it("exits 0 when the App and the org have everything", () => {
		const r = run(COMPLETE, [{ app_slug: "proagentstore", permissions: COMPLETE }]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("All permissions are granted and accepted.");
	});
});
