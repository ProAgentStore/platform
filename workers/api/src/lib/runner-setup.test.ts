/**
 * The checklist's `github_app` step (#1082) judges REACH, not rows: the live `resolveGithubAccess` every real
 * GitHub call makes, for EVERY bound GitHub repository's owner — and each refusal names a control that exists.
 *
 * The ChessClubs reproduction: the App was installed on the new org but this account was not authorized
 * there, and the step said "Install the App (Coding tab → Connect GitHub)" — the wrong remedy, naming a
 * control the Coding tab did not have. GitHub itself is faked per owner; the repositories are real rows.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { GithubAccessState } from "./github-app.js";

/** What GitHub says per owner in each test; absent = access works. */
let reach: Record<string, GithubAccessState | "throws">;
vi.mock("./github-app.js", async () => {
	const actual = await vi.importActual<typeof import("./github-app.js")>("./github-app.js");
	return {
		...actual,
		resolveGithubAccess: async (_env: Env, _uid: string, owner: string) => {
			const state = reach[owner.toLowerCase()];
			if (state === "throws") throw new Error("socket hang up");
			return state ? { ok: false, ...actual.githubAccessDenial({ state, owner, installUrl: "https://github.com/apps/proagentstore/installations/new" }) } : { ok: true, token: "t" };
		},
	};
});
const { GITHUB_CONNECTIONS_LINK, runnerSetupChecklist } = await import("./runner-setup.js");

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["lc-1"] });
	env = { DB: d1.DB, GITHUB_APP_SLUG: "proagentstore" } as unknown as Env;
	reach = {};
});
afterEach(() => d1.close());

let n = 0;
function repo(github: string | null, name = "app") {
	n++;
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, clone_status, workdir, updated_at)
		  VALUES ('r${n}', 'lc-1', 'u1', '${name}', ${github ? `'${github}'` : "NULL"}, '${github ? "github" : "local"}', 'ready', '/home/me/${name}', '2026-10-16 00:00:0${n}')`,
	);
}
const githubStep = async () => (await runnerSetupChecklist(env, "lc-1", "u1")).steps.find((s) => s.step === "github_app");

describe("the github_app step judges live access (#1082)", () => {
	it("the App installed but this account not authorized: not done, Connect GitHub / Sync installations, the Preferences link — never the install page", async () => {
		repo("ChessClubs-online/chess-clubs");
		reach = { "chessclubs-online": "not-authorized" };
		const step = await githubStep();
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/installed on "ChessClubs-online", but this account is not authorized/);
		expect(step?.instruction).toMatch(/Connect GitHub on the Coding tab/);
		expect(step?.instruction).toMatch(/Preferences → Connections → GitHub → Sync installations/);
		expect(step?.link).toBe(GITHUB_CONNECTIONS_LINK);
		expect(step?.owners).toEqual([{ owner: "ChessClubs-online", state: "not-authorized" }]);
	});

	it("the App not installed: not done, with the install link", async () => {
		repo("acme/app");
		reach = { acme: "not-installed" };
		const step = await githubStep();
		expect(step?.done).toBe(false);
		expect(step?.link).toBe("https://github.com/apps/proagentstore/installations/new");
	});

	it("every bound repository is checked, not just the newest — one unreachable owner is not done and is named", async () => {
		repo("acme/app", "app");
		repo("other-org/site", "site");
		reach = { "other-org": "not-authorized" };
		const step = await githubStep();
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/other-org/);
		expect(step?.owners).toEqual(expect.arrayContaining([{ owner: "acme", state: "ok" }, { owner: "other-org", state: "not-authorized" }]));
	});

	it("an uninstalled App or lost membership on a previously working owner reads not done (the check is live)", async () => {
		repo("acme/app");
		expect((await githubStep())?.done).toBe(true);
		reach = { acme: "not-authorized" };
		expect((await githubStep())?.done).toBe(false);
	});

	it("GitHub unreachable is not done, and says it is transient", async () => {
		repo("acme/app");
		reach = { acme: "throws" };
		const step = await githubStep();
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/could not be reached/);
	});

	it("before any GitHub repository is bound: not applicable yet — never done on some other binding", async () => {
		const step = await githubStep();
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/Not applicable yet/);
	});

	it("a repository not hosted on GitHub needs no GitHub access", async () => {
		repo(null, "notes");
		expect(await githubStep()).toMatchObject({ done: true, instruction: "Not needed: notes is not hosted on GitHub." });
	});

	it("access working everywhere: done", async () => {
		repo("acme/app");
		expect(await githubStep()).toMatchObject({ done: true, owners: [{ owner: "acme", state: "ok" }] });
	});
});

describe("the instruction names controls that exist (#1082)", () => {
	const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
	it("Sync installations and Reconnect are the console's real labels, and the Coding tab offers Connect GitHub", () => {
		const connections = read("../../../../store/console/src/components/AccountConnections.tsx");
		expect(connections).toContain("Sync installations");
		expect(connections).toContain('"Reconnect"');
		expect(read("../../../../agents/coder/web/src/RunnerSetupChecklist.tsx")).toContain("Connect GitHub");
		// The Preferences page is where those controls are mounted.
		expect(read("../../../../store/console/src/pages/Preferences.tsx")).toContain("<AccountConnections />");
	});
});
