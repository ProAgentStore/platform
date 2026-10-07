/**
 * The runner setup checklist (#868) — what a subscriber still has to do before a coding agent can
 * work on their own machine, each step with a LIVE verdict.
 *
 * The "Runner setup" board card used to say only "run `pags up`", and it said it whether or not
 * the runner was already up. A subscriber who has never used the CLI needs every step, and needs
 * to see which ones are done. Every verdict here is derived from state the API already records —
 * nothing is stored for the checklist itself, so it cannot disagree with what the platform does:
 *
 *   runner_connected  — any of the owner's registrations heartbeat inside the window
 *                       (`heartbeatFresh`): the CLI is installed, signed in and `pags up` is running.
 *   instance_attached — THIS instance's registration (default row or a node) is fresh.
 *   github_app        — the owner has a VERIFIED installation (`listUserInstallations`) on the bound
 *                       repository's owner; before a repository is bound, on any account.
 *   repo_bound        — a repository is bound WITH a local folder (#883: a folderless binding is
 *                       `needs_path`, and every repo read tool refuses it) and `admitRepoForRun`
 *                       would admit a run on it.
 *   engine_signed_in  — a session has started on the machine and no `engine.signin` card is
 *                       waiting for the owner.
 *
 * Owner-scoped throughout: every read names the caller's user id, so a checklist can only ever
 * describe the caller's own machines, installations and repositories.
 */
import { admitRepoForRun } from "./coding-repo-admission.js";
import { listRepos } from "./coding-store.js";
import { codingSessionLink, instanceBoardLink } from "./console-links.js";
import { listUserInstallations } from "./github-app.js";
import { heartbeatFresh } from "./runtime-attachment.js";
import type { Env } from "../types.js";

export const RUNNER_SETUP_STEPS = ["runner_connected", "instance_attached", "github_app", "repo_bound", "engine_signed_in"] as const;
export type RunnerSetupStepId = (typeof RUNNER_SETUP_STEPS)[number];

export interface RunnerSetupStep {
	step: RunnerSetupStepId;
	done: boolean;
	instruction: string;
	link?: string;
}

const CLI_INSTALL = "npm i -g @proagentstore/cli";

/** The freshest heartbeat among the owner's registrations, optionally for one instance only. */
async function latestHeartbeat(env: Env, userId: string, instanceId?: string): Promise<string | null> {
	const scope = instanceId ? " AND instance_id = ?2" : "";
	const stmt = env.DB.prepare(
		`SELECT MAX(last_seen_at) AS seen FROM (
		   SELECT last_seen_at FROM instance_runtimes WHERE user_id = ?1${scope}
		   UNION ALL
		   SELECT last_seen_at FROM instance_runtime_nodes WHERE user_id = ?1${scope}
		 )`,
	);
	const row = await (instanceId ? stmt.bind(userId, instanceId) : stmt.bind(userId)).first<{ seen: string | null }>();
	return row?.seen ?? null;
}

async function engineState(env: Env, instanceId: string, userId: string): Promise<{ started: boolean; signinPending: boolean }> {
	const row = await env.DB.prepare(
		`SELECT
		   EXISTS (SELECT 1 FROM coding_sessions WHERE instance_id = ?1 AND user_id = ?2) AS started,
		   EXISTS (SELECT 1 FROM instance_runtime_tasks
		            WHERE instance_id = ?1 AND user_id = ?2 AND type = 'engine.signin' AND status = 'needs_human' AND hidden = 0) AS pending`,
	)
		.bind(instanceId, userId)
		.first<{ started: number; pending: number }>();
	return { started: Boolean(row?.started), signinPending: Boolean(row?.pending) };
}

/** Where to install the App, when the deployment names it without a network call. */
function githubInstallLink(env: Env): string | undefined {
	return env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : undefined;
}

export async function runnerSetupChecklist(env: Env, instanceId: string, userId: string, now = Date.now()): Promise<{ ready: boolean; steps: RunnerSetupStep[] }> {
	const [anySeen, instanceSeen, repos, installs, engine] = await Promise.all([
		latestHeartbeat(env, userId),
		latestHeartbeat(env, userId, instanceId),
		listRepos(env, instanceId, userId),
		listUserInstallations(env, userId),
		engineState(env, instanceId, userId),
	]);
	const runnerUp = heartbeatFresh(anySeen, now);
	const attached = heartbeatFresh(instanceSeen, now);
	const repo = repos[0] ?? null;
	const coding = codingSessionLink(instanceId);

	const owner = repo?.provider === "github" ? (repo.githubRepo ?? repo.repoSlug ?? "").split("/")[0] ?? "" : "";
	const accounts = installs.map((i) => i.account.toLowerCase());
	const github: RunnerSetupStep = repo && repo.provider !== "github"
		? { step: "github_app", done: true, instruction: `Not needed: ${repo.name} is not hosted on GitHub.` }
		: owner
			? {
				step: "github_app",
				done: accounts.includes(owner.toLowerCase()),
				instruction: `Install the ProAgentStore GitHub App on ${owner} (Coding tab → Connect GitHub), so this agent can read and comment on its issues.`,
				link: githubInstallLink(env),
			}
			: {
				step: "github_app",
				done: accounts.length > 0,
				instruction: "Install the ProAgentStore GitHub App on the account that owns your repository (Coding tab → Connect GitHub).",
				link: githubInstallLink(env),
			};

	const admission = repo ? admitRepoForRun(repo) : null;
	const needsPath = repo?.cloneStatus === "needs_path" || Boolean(repo && !(repo.workdir ?? "").trim());
	const steps: RunnerSetupStep[] = [
		{
			step: "runner_connected",
			done: runnerUp,
			instruction: `On the machine that holds your repository: install the CLI (${CLI_INSTALL}), sign in with \`pags login\`, then run \`pags up\` and leave it running.`,
		},
		{
			step: "instance_attached",
			done: attached,
			instruction: runnerUp
				? "`pags up` is running but has not attached this agent — restart it (or run `pags up --force`) so it picks up agents you subscribed to after it started."
				: "Once `pags up` is running it attaches this agent automatically.",
			link: instanceBoardLink(instanceId),
		},
		github,
		{
			step: "repo_bound",
			done: Boolean(admission?.ok) && !needsPath,
			instruction: !repo
				? "Add your repository in the Coding tab — a GitHub repository, or a folder path on the machine running `pags up`."
				: admission && !admission.ok
					? admission.message
					: needsPath
						? `${repo.name} is bound but no folder on your machine is recorded for it, so the repo tools cannot read it. Set its folder in the Coding tab (repo settings), or call \`coding_repo_add\` with \`path\` (plus \`clone: true\` and \`github_repo\` if that folder has no checkout yet) — it attaches the folder to this binding in place.`
						: `${repo.name} is bound.`,
			link: coding,
		},
		{
			step: "engine_signed_in",
			done: engine.started && !engine.signinPending,
			instruction: engine.signinPending
				? "The coding engine on your machine is waiting for you to sign in — open the \"Sign in to the coding engine\" card on the board."
				: engine.started
					? "The coding engine is signed in."
					: "Sign the coding CLI (Claude Code, Codex or Grok) in on your machine with your own account. The first session asks for it if it is not.",
			link: engine.signinPending ? instanceBoardLink(instanceId) : coding,
		},
	];
	return { ready: steps.every((s) => s.done), steps };
}
