/**
 * What forgetting a machine would leave behind on GitHub (#1211): the Actions runners registered under that machine's label
 * (`pags-<node>`, #1113). `runner_node_forget_preflight` lists them so the owner sees the CI runners that would be orphaned — a
 * forgotten machine's runner stays registered with GitHub, offline, until it is removed.
 *
 * Read-only. Best effort: an org the App cannot list (not installed, or the runner permission is not accepted, #1207) is named in
 * `unreadable` with why, never skipped silently and never a failed preflight.
 */
import { GRANT_ALL_HINT } from "./github-app-permissions.js";
import { nodeRunnerLabel } from "./runner-routing.js";
import type { MintDeps } from "./actions-runner-provision.js";

export interface CiRunnerListing {
	org: string;
	id: number;
	name: string;
	status: string;
	busy: boolean;
}

export interface ForgetCiReport {
	/** Registered runners carrying one of the machine's labels. */
	runners: CiRunnerListing[];
	/** Orgs whose runners could not be listed, and why. */
	unreadable: Array<{ org: string; detail: string }>;
}

/** The labels a machine's runner carries, for every name the machine has used. An unusable name has none. */
export function labelsForNames(names: readonly string[]): string[] {
	const out = new Set<string>();
	for (const n of names) {
		try {
			out.add(nodeRunnerLabel(n));
		} catch {
			// An empty name has no label.
		}
	}
	return [...out];
}

export async function ciRunnersForForget(names: readonly string[], orgs: readonly string[], deps: MintDeps): Promise<ForgetCiReport> {
	const labels = labelsForNames(names);
	const report: ForgetCiReport = { runners: [], unreadable: [] };
	if (!labels.length) return report;
	for (const org of orgs) {
		try {
			const token = await deps.installationToken(org);
			if (!token) {
				report.unreadable.push({ org, detail: `The ProAgentStore GitHub App is not installed on ${org}.` });
				continue;
			}
			const res = await deps.fetch(`https://api.github.com/orgs/${org}/actions/runners?per_page=100`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ProAgentStore" } });
			if (!res.ok) {
				report.unreadable.push({ org, detail: res.status === 403 || res.status === 404 ? `GitHub refused to list ${org}'s runners (${res.status}); the App needs "Self-hosted runners: Read and write". ${GRANT_ALL_HINT}` : `GitHub returned ${res.status} listing ${org}'s runners.` });
				continue;
			}
			const runners = ((await res.json().catch(() => null)) as { runners?: Array<{ id?: number; name?: string; status?: string; busy?: boolean; labels?: Array<{ name?: string }> }> } | null)?.runners ?? [];
			for (const r of runners) {
				if (typeof r.id === "number" && typeof r.name === "string" && (r.labels ?? []).some((l) => typeof l.name === "string" && labels.includes(l.name))) report.runners.push({ org, id: r.id, name: r.name, status: r.status ?? "offline", busy: r.busy === true });
			}
		} catch (e) {
			report.unreadable.push({ org, detail: e instanceof Error ? e.message : "unreadable" });
		}
	}
	return report;
}
