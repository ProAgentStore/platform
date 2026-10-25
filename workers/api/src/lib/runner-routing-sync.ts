/**
 * Minutes-aware routing, executed (#1212, #1113 follow-up 6): read an org's Actions usage, decide each repo's route with
 * `selectRunnerLabel`, and bring the repo's `PAGS_RUNNER` Actions variable to it — and back again when the billing cycle resets.
 *
 * Every GitHub call and every side effect comes in through {@link RouteSyncDeps}, so the rules run here against a faked GitHub; the
 * live deps are {@link liveRouteSyncDeps}. Nothing calls {@link syncRepoRoutes} on a schedule yet: the loop that does is #1211, and
 * writing a variable needs the App's "Variables: Read and write" permission accepted on the org (#1207). Until then a write answers
 * `denied` with the permission to grant, and the repo keeps whatever route it had.
 *
 *   • **Minutes.** The org's billing usage for the current cycle (`GET /organizations/{org}/settings/billing/usage`), the Actions minutes
 *     summed with GitHub's multipliers (macOS ×10, Windows ×2), over the plan's included minutes (free 2,000 / team 3,000 / enterprise
 *     50,000, or an explicit `includedMinutes`). Only a share is known from here, never "exhausted": that comes from a run that did not
 *     start for billing (#1112), passed in as `failureReason`. An unreadable org is `unreadable` — GitHub-hosted stays, nothing flips.
 *   • **Flip back.** The decision has no memory: a new cycle reads low usage, the route is GitHub-hosted, and the variable is removed.
 *   • **GitHub-hosted means UNSET.** The workflows read `fromJSON(vars.PAGS_RUNNER || '"ubuntu-24.04"')` (#1214): writing the
 *     directive's `"ubuntu-latest"` would override their pin (#1266), so going back deletes the variable.
 *   • **Every flip is traced and notified.** A change to the route calls `onFlip`; a write that failed does not claim it happened.
 */
import { logEvent } from "./events.js";
import type { MintDeps } from "./actions-runner-provision.js";
import { createNotification } from "../routes/notifications.js";
import { desiredRoute } from "./runner-reconcile.js";
import { type MinutesState, PAGS_RUNNER_VARIABLE, type RepoVisibility, type RoutingReason, type RunnerRoutingMode } from "./runner-routing.js";
import type { StartFailure } from "./github-actions.js";
import type { Env } from "../types.js";

/** Included Actions minutes per month by plan (GitHub's published allotments for private repositories). */
export const INCLUDED_MINUTES_BY_PLAN: Readonly<Record<string, number>> = { free: 2000, team: 3000, enterprise: 50000 };

/** GitHub bills macOS minutes at 10× and Windows at 2× against the included allotment. */
export function minuteMultiplier(sku: string): number {
	const s = sku.toLowerCase();
	if (s.includes("macos")) return 10;
	if (s.includes("windows")) return 2;
	return 1;
}

export interface UsageItem {
	product?: string;
	sku?: string;
	quantity?: number;
	unitType?: string;
}

/** Actions minutes used this cycle, multiplier applied — hosted runners only (a self-hosted minute is not billed and is not listed). */
export function actionsMinutesUsed(items: readonly UsageItem[]): number {
	return items.reduce((sum, i) => (i.product?.toLowerCase() === "actions" && i.unitType?.toLowerCase() === "minutes" && typeof i.quantity === "number" ? sum + i.quantity * minuteMultiplier(i.sku ?? "") : sum), 0);
}

export type OrgMinutes = { source: "billing_api"; minutes: MinutesState; usedMinutes: number; includedMinutes: number } | { source: "unreadable"; minutes: MinutesState; detail: string };

const unreadable = (detail: string): OrgMinutes => ({ source: "unreadable", minutes: {}, detail });

export interface RouteSyncDeps extends MintDeps {
	/** Called once for each route that changed, after the write succeeded. Trace and notify here. */
	onFlip: (flip: RouteFlip) => Promise<void>;
}

const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" });

/** The org's Actions usage this cycle as a share of what its plan includes. Unknown is `unreadable`, never "fine" and never "exhausted". */
export async function readOrgMinutes(org: string, deps: Pick<RouteSyncDeps, "installationToken" | "fetch">, opts: { includedMinutes?: number } = {}): Promise<OrgMinutes> {
	const token = await deps.installationToken(org);
	if (!token) return unreadable(`The ProAgentStore GitHub App is not installed on ${org}.`);
	let included = opts.includedMinutes;
	if (included === undefined) {
		const res = await deps.fetch(`https://api.github.com/orgs/${org}`, { headers: ghHeaders(token) });
		const plan = res.ok ? (((await res.json().catch(() => null)) as { plan?: { name?: unknown } } | null)?.plan?.name ?? null) : null;
		included = typeof plan === "string" ? INCLUDED_MINUTES_BY_PLAN[plan.toLowerCase()] : undefined;
		if (!included) return unreadable(`${org}'s plan could not be read, so the share of included minutes is unknown.`);
	}
	const res = await deps.fetch(`https://api.github.com/organizations/${org}/settings/billing/usage`, { headers: ghHeaders(token) });
	if (!res.ok) return unreadable(res.status === 403 || res.status === 404 ? `GitHub refused ${org}'s billing usage (${res.status}); the App needs "Administration: Read-only" on the org, see #1207.` : `GitHub returned ${res.status} for ${org}'s billing usage.`);
	const items = ((await res.json().catch(() => null)) as { usageItems?: unknown } | null)?.usageItems;
	if (!Array.isArray(items)) return unreadable(`GitHub's billing usage for ${org} had no usage items.`);
	const usedMinutes = actionsMinutesUsed(items as UsageItem[]);
	return { source: "billing_api", minutes: { usedPercent: Math.round((usedMinutes / included) * 1000) / 10 }, usedMinutes, includedMinutes: included };
}

/** The repo's `PAGS_RUNNER` value, raw; null when unset. Throws on anything but found / not found. */
export async function readRouteVariable(repo: string, deps: Pick<RouteSyncDeps, "installationToken" | "fetch">): Promise<{ value: string | null } | { denied: string }> {
	const token = await deps.installationToken(repo.split("/")[0]);
	if (!token) return { denied: `The ProAgentStore GitHub App is not installed on ${repo.split("/")[0]}.` };
	const res = await deps.fetch(`https://api.github.com/repos/${repo}/actions/variables/${PAGS_RUNNER_VARIABLE}`, { headers: ghHeaders(token) });
	if (res.status === 404) return { value: null };
	if (res.status === 403) return { denied: variablesDenied(repo) };
	if (!res.ok) throw new Error(`GitHub returned ${res.status} reading ${PAGS_RUNNER_VARIABLE} on ${repo}`);
	const v = ((await res.json().catch(() => null)) as { value?: unknown } | null)?.value;
	return { value: typeof v === "string" ? v : null };
}

const variablesDenied = (repo: string) => `GitHub refused the ${PAGS_RUNNER_VARIABLE} variable on ${repo}. The ProAgentStore App needs "Variables: Read and write" on the repository, accepted on the org's installation — see #1207.`;

/** Set the variable (create or update) or, with `value` null, remove it. `denied` carries the permission to grant. */
export async function writeRouteVariable(repo: string, value: string | null, existed: boolean, deps: Pick<RouteSyncDeps, "installationToken" | "fetch">): Promise<{ ok: true } | { denied: string }> {
	const token = await deps.installationToken(repo.split("/")[0]);
	if (!token) return { denied: `The ProAgentStore GitHub App is not installed on ${repo.split("/")[0]}.` };
	const base = `https://api.github.com/repos/${repo}/actions/variables`;
	const headers = { ...ghHeaders(token), "Content-Type": "application/json" };
	const res =
		value === null
			? await deps.fetch(`${base}/${PAGS_RUNNER_VARIABLE}`, { method: "DELETE", headers })
			: existed
				? await deps.fetch(`${base}/${PAGS_RUNNER_VARIABLE}`, { method: "PATCH", headers, body: JSON.stringify({ name: PAGS_RUNNER_VARIABLE, value }) })
				: await deps.fetch(base, { method: "POST", headers, body: JSON.stringify({ name: PAGS_RUNNER_VARIABLE, value }) });
	if (res.status === 403) return { denied: variablesDenied(repo) };
	if (res.status === 404 && value === null) return { ok: true }; // already gone
	if (!res.ok) throw new Error(`GitHub returned ${res.status} writing ${PAGS_RUNNER_VARIABLE} on ${repo}`);
	return { ok: true };
}

export interface RouteRepo {
	/** `owner/name`. */
	repo: string;
	visibility: RepoVisibility | string;
	/** The machine the repo's Coder is pinned to; null when unpinned. */
	pinnedNode: string | null;
	/** A recent run's #1112 start-failure classification, if any. */
	failureReason?: Pick<StartFailure, "classification"> | null;
}

export interface RouteFlip {
	repo: string;
	from: RunnerRoutingMode;
	to: RunnerRoutingMode;
	/** The variable now: the pinned machine's label set as JSON, or null (unset = GitHub-hosted). */
	value: string | null;
	reason: RoutingReason;
	/** Set when the owner must know more than the flip: the pinned machine is offline, or jobs are waiting for it. */
	alert: string | null;
	summary: string;
}

export type RouteSyncResult =
	/** `alert`: the owner needs to know although nothing changed — the pinned machine is offline. The caller notifies; the sync does not repeat it. */
	| { repo: string; status: "unchanged"; mode: RunnerRoutingMode; alert: string | null }
	| { repo: string; status: "flipped"; flip: RouteFlip }
	| { repo: string; status: "denied"; detail: string }
	| { repo: string; status: "failed"; detail: string };

/** The mode a stored value means: unset is GitHub-hosted; anything naming `self-hosted` is the self-hosted route. */
function modeOf(value: string | null): RunnerRoutingMode {
	return value?.includes("self-hosted") ? "self-hosted" : "github-hosted";
}

/**
 * Bring each repo's `PAGS_RUNNER` to the route its org's minutes and its pinned machine call for. Minutes are read once per org.
 * One repo failing never stops the others; a write GitHub refuses is `denied` and reports nothing as flipped.
 */
export async function syncRepoRoutes(repos: readonly RouteRepo[], onlineNodes: ReadonlySet<string>, deps: RouteSyncDeps, opts: { includedMinutes?: number } = {}): Promise<RouteSyncResult[]> {
	const minutesByOrg = new Map<string, Promise<OrgMinutes>>();
	const out: RouteSyncResult[] = [];
	for (const r of repos) {
		try {
			const org = r.repo.split("/")[0];
			if (!minutesByOrg.has(org)) minutesByOrg.set(org, readOrgMinutes(org, deps, opts).catch((e) => unreadable(e instanceof Error ? e.message : "unreadable")));
			const org_ = await (minutesByOrg.get(org) as Promise<OrgMinutes>);
			// A run that did not start because the minutes are gone IS the evidence that they are gone, which the usage share alone cannot show.
			const minutes: MinutesState = r.failureReason?.classification === "minutes_exhausted" ? { ...org_.minutes, exhausted: true } : org_.minutes;
			const { directive, alert } = desiredRoute({ repo: r.repo, visibility: r.visibility, pinnedNode: r.pinnedNode, minutes, failureReason: r.failureReason }, onlineNodes);
			const current = await readRouteVariable(r.repo, deps);
			if ("denied" in current) {
				out.push({ repo: r.repo, status: "denied", detail: current.denied });
				continue;
			}
			// GitHub-hosted is the variable UNSET, so the workflows' own pinned fallback applies (#1214, #1266).
			const desired = directive.mode === "self-hosted" ? directive.variableValue : null;
			const same = directive.mode === "self-hosted" ? sameValue(current.value, desired) : modeOf(current.value) === "github-hosted" && current.value === null;
			if (same) {
				out.push({ repo: r.repo, status: "unchanged", mode: directive.mode, alert: alert ?? null });
				continue;
			}
			const written = await writeRouteVariable(r.repo, desired, current.value !== null, deps);
			if ("denied" in written) {
				out.push({ repo: r.repo, status: "denied", detail: written.denied });
				continue;
			}
			const from = modeOf(current.value);
			const flip: RouteFlip = {
				repo: r.repo,
				from,
				to: directive.mode,
				value: desired,
				reason: directive.reason,
				alert: alert ?? null,
				summary: directive.mode === "self-hosted" ? `${r.repo} now runs its jobs on ${directive.labels.join(", ")} (${describe(directive.reason, org_)}).` : `${r.repo} is back on GitHub-hosted runners (${describe(directive.reason, org_)}).`,
			};
			await deps.onFlip(flip);
			out.push({ repo: r.repo, status: "flipped", flip });
		} catch (e) {
			out.push({ repo: r.repo, status: "failed", detail: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

function sameValue(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	try {
		return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
	} catch {
		return a === b;
	}
}

function describe(reason: RoutingReason, m: OrgMinutes): string {
	switch (reason) {
		case "minutes_exhausted":
			return "the org's Actions minutes are used up";
		case "minutes_low":
			return `the org has used ${m.minutes.usedPercent ?? "most of"}% of its Actions minutes`;
		case "run_not_started_for_billing":
			return "a run did not start for billing reasons";
		case "not_private":
			return "only private repositories may use a self-hosted runner";
		case "not_pinned":
			return "no machine is pinned for this repo";
		default:
			return m.source === "unreadable" ? "the org's minutes could not be read, so the default stands" : "minutes are available again";
	}
}

/** Live deps: the App's installation token, SSRF-safe fetch, and a flip that is traced and put in front of the owner. */
export function liveRouteSyncDeps(env: Env, userId: string, base: MintDeps, notifyTo: { userId: string; instanceId?: string } = { userId }): RouteSyncDeps {
	return {
		...base,
		onFlip: async (flip) => {
			await logEvent(env, { source: "runner", event: "runner_routing.flip", userId, instanceId: notifyTo.instanceId ?? null, message: flip.summary, context: { repo: flip.repo, from: flip.from, to: flip.to, reason: flip.reason, value: flip.value, alert: flip.alert } });
			await createNotification(env.DB, notifyTo.userId, "runner_routing", flip.to === "self-hosted" ? `${flip.repo}: CI moved to your machine` : `${flip.repo}: CI back on GitHub-hosted`, [flip.summary, flip.alert].filter(Boolean).join(" "), undefined, undefined, { kind: flip.alert ? "alert" : "update", dedupeKey: `runner-routing:${flip.repo}:${flip.to}`, instanceId: notifyTo.instanceId });
		},
	};
}
