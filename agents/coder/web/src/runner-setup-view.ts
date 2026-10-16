// The local runner setup checklist, as the Coding tab shows it (#869). The verdicts are the
// server's — `GET /v1/instances/:id/runner-setup` (#868) derives every one from recorded state —
// so this decides only whether to show the card, which step is next, and where each link goes.

export type RunnerSetupStepId = "runner_connected" | "instance_attached" | "github_app" | "repo_bound" | "engine_signed_in";

export interface RunnerSetupStep {
	step: RunnerSetupStepId;
	done: boolean;
	instruction: string;
	link?: string;
	/** `github_app` (#1082): each bound GitHub owner and whether access works there. */
	owners?: Array<{ owner: string; state: string }>;
}

export interface RunnerSetupAnswer {
	instanceId: string;
	ready: boolean;
	steps: RunnerSetupStep[];
}

export const RUNNER_SETUP_TITLES: Record<RunnerSetupStepId, string> = {
	runner_connected: "Install the CLI and run pags up",
	instance_attached: "Attach this agent to your machine",
	github_app: "Connect GitHub",
	repo_bound: "Bind your repository",
	engine_signed_in: "Sign in to the coding engine",
};

export type RunnerSetupLink = { kind: "route"; to: string } | { kind: "external"; href: string };

export interface RunnerSetupRow {
	id: string;
	title: string;
	done: boolean;
	/** The first step not yet done — the one to do now. */
	current: boolean;
	instruction: string;
	link: RunnerSetupLink | null;
}

export interface RunnerSetupView {
	doneCount: number;
	total: number;
	rows: RunnerSetupRow[];
}

/**
 * A step's link as somewhere to go, or null when there is nowhere useful.
 *
 * The API emits console links as `/console/…`; the router is mounted under that base, so it comes
 * off (the same rule as the console's `notificationRoute`). A link back to the Coding tab the user
 * is already on is dropped — a button that reloads the page they are reading is not a next step.
 */
export function runnerSetupLink(link: string | undefined, codingPath: string): RunnerSetupLink | null {
	if (!link) return null;
	if (/^https:\/\//.test(link)) return { kind: "external", href: link };
	if (!link.startsWith("/")) return null;
	const to = link === "/console" || link === "/console/" ? "/" : link.startsWith("/console/") ? link.slice("/console".length) : link;
	return to === codingPath ? null : { kind: "route", to };
}

/** The card to render, or null: nothing answered yet, setup finished, or an answer with no steps. */
export function runnerSetupView(answer: RunnerSetupAnswer | null, codingPath: string): RunnerSetupView | null {
	if (!answer || answer.ready || !answer.steps?.length) return null;
	const current = answer.steps.findIndex((s) => !s.done);
	return {
		doneCount: answer.steps.filter((s) => s.done).length,
		total: answer.steps.length,
		rows: answer.steps.map((s, i) => ({
			id: s.step,
			title: RUNNER_SETUP_TITLES[s.step] ?? s.step,
			done: s.done,
			current: i === current,
			instruction: s.instruction,
			link: runnerSetupLink(s.link, codingPath),
		})),
	};
}

/**
 * The owners Connect GitHub can fix (#1082): the App is installed there but this account is not
 * authorized — a sync of the installations binds them. An owner without the App needs installing first,
 * which the step's own link covers.
 */
export function githubConnectOwners(answer: RunnerSetupAnswer | null): string[] {
	const step = answer?.steps?.find((s) => s.step === "github_app");
	if (!step || step.done) return [];
	return (step.owners ?? []).filter((o) => o.state === "not-authorized").map((o) => o.owner);
}

/** One owner's answer from `POST /v1/github/installations/sync`, as a sentence. */
export function githubSyncSentence(org: { account: string; result: string; reason?: string }): string {
	if (org.result === "bound" || org.result === "already_bound") return `${org.account}: connected.`;
	if (org.result === "not_installed") return `${org.account}: the ProAgentStore App is not installed there — install it first.`;
	const why: Record<string, string> = {
		not_member: "your linked GitHub account is not a member of it",
		membership_pending: "your invitation to it is still pending — accept it on GitHub",
		app_cannot_read_members: "the App cannot read its members — Reconnect GitHub in Preferences → Connections",
		oauth_app_restricted: "it restricts third-party access — approve ProAgentStore, then Reconnect GitHub",
	};
	return `${org.account}: not connected — ${why[org.reason ?? ""] ?? (org.reason ?? "the check failed").replace(/_/g, " ")}.`;
}
