/**
 * The `## Deployment` block — the repo the subscriber saved in the console Deployment card, and
 * the build state the console renders beside it (#494).
 *
 * ── What happened
 *
 * An owner told his Operator "I saved it into settings, I saved it as Heartfull Organization and
 * Request Platform. Check again." It replied: "I don't have the GitHub URL stored in my memory —
 * only the fact that issues were being documented there. Can you give me the repo URL or the
 * organisation name?" He had saved it. `GET /deploy-status` on that instance, in that minute,
 * returned `heartfull-online/platform` with a green run. The agent looked in memory because that
 * was the only place it could look.
 *
 * ── Why
 *
 * `config.githubRepo` had exactly one reader. `instances-deploy.ts` writes it on PUT and reads it
 * back on GET for the console; `grep -c githubRepo agent-think.ts` returned 0. That route's own
 * header states the design honestly — "its only knowledge of a GitHub repo is a
 * `config.githubRepo` field the subscriber sets once" — and the instance could not see it.
 *
 * This is #255 exactly, one store later: `repos:"single"` was read ONLY by the console and nothing
 * ever told the agent. #488 shipped a third console-only store and reproduced it. The platform
 * already does the opposite for the two subscriber-set stores that predate it — typed settings as
 * `## Settings`, Rules & Tips as `## Subscriber Rules` — so the fix is to put this one where those
 * already are rather than to invent a mechanism.
 *
 * ── Why the BUILD is here and not left to a tool
 *
 * The same owner asked "Was it deployed?" twice, hours apart. Both times the agent answered by
 * reading a scraped tmux pane, and the second answer was a guess about an expired domain, while
 * run #597 sat `success` in GitHub Actions. So the gap was never only "which repo": the whole
 * build state the console renders for this agent was invisible to it.
 *
 * Stated rather than made contingent on the model deciding to call something — the same reasoning
 * `agent-think.ts` gives for injecting recent work instead of leaving it to `check_work`. A model
 * that must first choose to look before it can answer a direct challenge will often just guess.
 *
 * ── Why every line carries its age
 *
 * A build line with no timestamp is read as "now", and "the last run succeeded" then becomes "it
 * is deployed". Those are different claims and the difference is exactly what the owner was asking
 * about. Same treatment the terminal lines get: the label is written so a stale reading cannot be
 * upgraded into a live one.
 */
import { localStamp } from "./agent-clock.js";
import type { BuildRun } from "./build-history.js";
import { latestHostedBuild } from "./hosted-repo.js";
import type { Env } from "../types.js";

/**
 * Does a candidate look like `owner/repo`?
 *
 * Lives here, and `instances-deploy.ts` imports it, so the route that STORES the value and the
 * prompt that STATES it cannot disagree about what counts as configured. A second opinion would
 * mean an agent announcing a repo the status route refuses to poll, or the reverse.
 */
export function isValidGithubRepo(s: unknown): s is string {
	if (typeof s !== "string") return false;
	const parts = s.trim().split("/");
	return parts.length >= 2 && parts.every((p) => p.length > 0);
}

/** How the run's own words become a verdict. `unknown`-typed on BuildRun, so narrowed here. */
function describeRun(run: BuildRun): string {
	const status = typeof run.status === "string" ? run.status : "";
	const conclusion = typeof run.conclusion === "string" ? run.conclusion : "";
	if (status === "completed") {
		if (conclusion === "success") return "SUCCEEDED";
		if (conclusion === "failure") return "FAILED";
		if (conclusion === "cancelled") return "was CANCELLED";
		if (conclusion === "timed_out") return "TIMED OUT";
		// A conclusion nobody enumerated is reported verbatim rather than flattened to "finished" —
		// the leaked-enum-token failure from #416, but the opposite direction: inventing a friendly
		// word for `action_required` would state something the run does not say.
		return conclusion ? `completed with conclusion "${conclusion}"` : "completed";
	}
	if (status === "in_progress") return "is STILL RUNNING";
	if (status === "queued") return "is QUEUED and has not started";
	return status ? `reports status "${status}"` : "reports no status";
}

/** `#597 on `main` (39f7069)` — only the parts the run actually carries. */
function identify(run: BuildRun): string {
	const bits: string[] = [];
	if (typeof run.name === "string" && run.name.trim()) bits.push(`"${run.name.trim()}"`);
	if (run.runNumber != null) bits.push(`#${run.runNumber}`);
	if (run.branch) bits.push(`on ${run.branch}`);
	if (run.sha) bits.push(`(${String(run.sha).slice(0, 7)})`);
	return bits.join(" ");
}

/** The build lookup's three outcomes, kept distinct — "unavailable" is not "no runs". */
export interface DeployBuildResult {
	available: boolean;
	run: BuildRun | null;
}

/**
 * The block, or `""` when the subscriber has configured no repo.
 *
 * Pure: `build` is already-fetched, so the wording is testable without a network. `null` means the
 * lookup was not attempted or threw, which is deliberately NOT the same as `{available:false}` —
 * one is "I did not look", the other is "GitHub would not tell me", and an agent that conflates
 * them ends up asserting a repo is unreachable when the chat turn simply timed out.
 */
export function deploymentPrompt(
	repo: unknown,
	build: DeployBuildResult | null,
	opts: { now: number; timeZone?: string } = { now: Date.now() },
): string {
	if (!isValidGithubRepo(repo)) return "";
	const slug = repo.trim();

	let line: string;
	if (build === null) {
		line =
			"Build status: NOT CHECKED this turn. Say you could not check it — do not guess, and do not" +
			" substitute what a terminal pane shows.";
	} else if (!build.available) {
		line =
			"Build status: UNAVAILABLE — the GitHub App may not be installed for this repository, or the" +
			" lookup failed. Say exactly that rather than inferring a deploy from anything else.";
	} else if (!build.run) {
		line = `Build status: GitHub Actions reports NO runs at all for ${slug}.`;
	} else {
		const stamp = localStamp(build.run.updatedAt, opts.timeZone);
		const ms = build.run.updatedAt ? Date.parse(build.run.updatedAt) : Number.NaN;
		const age = Number.isFinite(ms) ? ` — ${ago(opts.now - ms)}` : "";
		const ident = identify(build.run);
		line =
			`Latest GitHub Actions run${ident ? ` ${ident}` : ""} ${describeRun(build.run)}` +
			`${stamp ? `, last updated ${stamp}` : ""}${age}.` +
			(build.run.url ? ` ${build.run.url}` : "") +
			"\nThat is the state AT THAT TIME and says nothing about anything since. A successful run is not" +
			" proof that the site is up now, and it is not permission to say a change you made later has" +
			" shipped. It DOES outrank a terminal pane: never answer a deploy question from scrollback" +
			" when this line is present.";
	}

	return (
		"\n\n## Deployment\n" +
		`This agent tracks the GitHub repository \`${slug}\`. The subscriber set it in the console →` +
		" Deployment card, so it is authoritative: when asked which repository, organisation or project" +
		" you work on, answer with it. Never ask the subscriber for it and never answer from memory —" +
		" a memory entry that disagrees with this line is out of date.\n" +
		line
	);
}

/** Round to a human interval. Exact ms in a prompt invites the model to quote it back as precision. */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/**
 * How long the chat turn will wait for GitHub before giving up on the build line.
 *
 * The repo half of this block needs no I/O and must never be lost to the build half's latency:
 * that is why a timeout yields `null` (rendered as "NOT CHECKED") instead of dropping the section.
 * Same posture as the live terminal capture, which races a runner round-trip and falls back rather
 * than blocking the reply.
 */
export const DEPLOY_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Resolve the block for a real instance: read the configured repo, best-effort fetch the latest
 * build, render.
 *
 * The I/O sits beside the wording rather than in `agent-think.ts` because the two must agree about
 * the three outcomes above — "not checked", "unavailable", "no runs" — and splitting them is how a
 * timeout starts rendering as "GitHub says no". Never throws: every failure degrades to a stated
 * absence, because a chat turn must not die over a status line.
 */
export async function deploymentContext(
	env: Env,
	userId: string | undefined,
	config: Record<string, unknown>,
	opts: { now: number; timeZone?: string },
): Promise<string> {
	const repo = config.githubRepo;
	if (!isValidGithubRepo(repo)) return "";
	if (!userId) return deploymentPrompt(repo, null, opts);
	const slug = repo.trim();
	const ref = { provider: "github" as const, githubRepo: slug, repoSlug: slug };
	const build = await Promise.race([
		latestHostedBuild(env, userId, ref).catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), DEPLOY_LOOKUP_TIMEOUT_MS)),
	]).catch(() => null);
	return deploymentPrompt(repo, build, opts);
}
