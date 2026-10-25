/**
 * What the release-notes panel says about the exact-SHA gate, and the request its editor sends (#1347).
 * Pure functions of the server's answer (`gate`, `settings`, `effective`) and of the runner reads. The
 * backend stays the validation authority (`validateRequiredWorkflows`): the checks here only spare the
 * owner a round trip and decide where an answer is shown; a draft this file accepts can still be refused.
 */
import type { InstanceReleaseNotesResponse, ReleaseGateState } from "./types";
import type { Machine, NodeDetail } from "./runnerPanel";

/** A gated direct push needs the runner to report the old and new SHA of the push (#1345). */
export const MIN_GATED_RUNNER = "0.4.179";

/** The longest job or step name the server accepts (`SELECTOR_MAX`). */
export const SELECTOR_MAX = 200;
export const WORKFLOWS_MIN = 2;
export const WORKFLOWS_MAX = 10;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

export type GateRole = "check" | "production_deploy";
type SavedGate = NonNullable<InstanceReleaseNotesResponse["settings"]["requiredWorkflows"]>;

/** One editable row. The selectors are strings while editing and only travel on the deploy row. */
export interface GateRow {
	path: string;
	role: GateRole;
	jobName: string;
	stepName: string;
}

export const emptyRow = (role: GateRole = "check"): GateRow => ({ path: "", role, jobName: "", stepName: "" });

/** The editor's starting rows: what is saved, or a check plus the deploy for a fresh gate. */
export function draftFromSaved(saved: SavedGate | undefined): GateRow[] {
	if (!saved?.length) return [emptyRow("check"), emptyRow("production_deploy")];
	return saved.map((w) => ({ path: w.path, role: w.role, jobName: w.jobName ?? "", stepName: w.stepName ?? "" }));
}

/** Make row `index` the one production deploy; every other row becomes a check and loses its selectors. */
export function chooseDeploy(rows: readonly GateRow[], index: number): GateRow[] {
	return rows.map((r, i) => (i === index ? { ...r, role: "production_deploy" as const } : { ...r, role: "check" as const, jobName: "", stepName: "" }));
}

export const draftChanged = (rows: readonly GateRow[], saved: SavedGate | undefined): boolean => JSON.stringify(rows) !== JSON.stringify(draftFromSaved(saved));

export interface DraftProblems {
	/** Messages for row `i`, shown beside that row. */
	rows: Record<number, string>;
	/** About the set as a whole (count, no deploy row). */
	form?: string;
}

/** Why a draft cannot be sent yet. Empty `rows` and no `form` means it can. Mirrors the server's rules. */
export function draftProblems(rows: readonly GateRow[]): DraftProblems {
	const problems: DraftProblems = { rows: {} };
	if (rows.length < WORKFLOWS_MIN || rows.length > WORKFLOWS_MAX) problems.form = `A gate needs ${WORKFLOWS_MIN}–${WORKFLOWS_MAX} workflow files; this has ${rows.length}.`;
	else if (rows.filter((r) => r.role === "production_deploy").length !== 1) problems.form = "Mark exactly one workflow as the production deploy.";
	const seen = new Set<string>();
	rows.forEach((r, i) => {
		const path = r.path.trim();
		const found: string[] = [];
		if (!WORKFLOW_PATH.test(path)) found.push("Use an exact path such as .github/workflows/ci.yml.");
		else if (seen.has(path)) found.push("This workflow is already listed.");
		seen.add(path);
		if (r.role === "production_deploy") {
			for (const [field, label] of [["jobName", "job"], ["stepName", "step"]] as const) {
				const v = r[field];
				if (!v.trim()) found.push(`Name the deploy ${label} exactly as GitHub Actions shows it.`);
				else if (v !== v.trim()) found.push(`The ${label} name has spaces at its start or end.`);
				else if (v.length > SELECTOR_MAX) found.push(`The ${label} name is longer than ${SELECTOR_MAX} characters.`);
			}
		}
		if (found.length) problems.rows[i] = found.join(" ");
	});
	return problems;
}

export const draftIsValid = (rows: readonly GateRow[]): boolean => {
	const p = draftProblems(rows);
	return !p.form && Object.keys(p.rows).length === 0;
};

/** The PUT body. Only `requiredWorkflows`: a gate edit never carries `enabled` or `channels`. */
export function savePatch(rows: readonly GateRow[]): { requiredWorkflows: Array<{ path: string; role: GateRole; jobName?: string; stepName?: string }> } {
	return {
		requiredWorkflows: rows.map((r) => (r.role === "production_deploy" ? { path: r.path.trim(), role: r.role, jobName: r.jobName, stepName: r.stepName } : { path: r.path.trim(), role: r.role })),
	};
}

/** Clearing the gate returns to the immediate status note; `null` is the route's "remove this field". */
export const clearPatch = (): { requiredWorkflows: null } => ({ requiredWorkflows: null });

/**
 * Which row a server refusal belongs to. The server answers with one sentence, not a row index, so this
 * reads the sentence: selector complaints belong to the deploy row, a repeated path to the later row
 * that repeats it. Anything else is shown for the whole gate rather than pinned to a row it may not be about.
 */
export function rowForServerError(message: string, rows: readonly GateRow[]): number | null {
	if (/repeat a workflow path/i.test(message)) {
		const seen = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			if (seen.has(rows[i].path.trim())) return i;
			seen.add(rows[i].path.trim());
		}
		return null;
	}
	if (/jobName|stepName|production_deploy/.test(message)) {
		const at = rows.findIndex((r) => r.role === "production_deploy");
		return at >= 0 ? at : null;
	}
	return null;
}

export interface ModeCopy {
	mode: "status" | "verified" | "setup_needed";
	title: string;
	body: string;
}

/** The delivery mode the saved gate puts this agent in, in the words the panel opens with. */
export function modeCopy(gate: ReleaseGateState): ModeCopy {
	if (gate.state === "ready") {
		return {
			mode: "verified",
			title: "Verified production note",
			body: "Waits until every workflow below has succeeded for the one pushed commit and the deploy job and step have succeeded. If any proof is missing, failed, skipped or unclear, the note is held rather than posted; it is never guessed from the branch head.",
		};
	}
	if (gate.state === "configuration_required") {
		return {
			mode: "setup_needed",
			title: "Verified production note: setup needed",
			body: gate.message ?? "This gate is missing the deploy job and step, so its notes are held, not posted.",
		};
	}
	return {
		mode: "status",
		title: "Status note after a trunk-changing run",
		body: "Posts one note when a run ships to the default branch: what changed and the issues it closed. It does not wait for workflows and does not prove the change was deployed. Add a gate below to hold the note until the deploy is verified.",
	};
}

/** `1.2.3` → [1,2,3]; anything else (a tag, a suffix, an empty string) is not comparable, and not guessed at. */
function parseVersion(v: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive like a comparator; `null` when either side is not a plain x.y.z version. */
export function compareVersions(a: string, b: string): number | null {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

export interface RunnerReading {
	/** The machine the agent's runs go to: the pinned one, else the one the platform resolved. */
	node: string | null;
	/** `null` when neither read says. */
	connected: boolean | null;
	version: string | null;
}

/** `GET /v1/instances/:id/runner-node`, the part this reads. */
export interface RunnerNodeRead {
	runnerNode: string | null;
	nodesDetail?: NodeDetail[];
	resolvedNode?: string | null;
}

/**
 * Join the agent's runner-node read to the machine list, which is where the CLI version lives. A name is
 * matched under every name the machine has used, as the Runner card does. A failed read is a `null`
 * input and reads as unknown, never as fine.
 */
export function readRunner(rn: RunnerNodeRead | null, machines: readonly Machine[] | null): RunnerReading {
	const node = rn ? rn.resolvedNode || rn.runnerNode || null : null;
	if (!node) return { node: null, connected: null, version: null };
	const machine = machines?.find((m) => m.node === node || (m.aka ?? []).includes(node));
	const detail = rn?.nodesDetail?.find((d) => d.node === node);
	const connected = detail || machine ? detail?.connected === true || machine?.connected === true || detail?.nodeOnline === true : null;
	return { node, connected, version: machine?.runnerVersion?.trim() || null };
}

export type ReadinessId = "off" | "no_channel" | "none_selected" | "bot_not_in_channel" | "no_gate" | "gate_setup" | "runner";

export interface Readiness {
	/** True only when nothing below applies. The panel says "ready" for no other state. */
	ready: boolean;
	items: Array<{ id: ReadinessId; text: string }>;
}

export interface ReadinessInput {
	view: InstanceReleaseNotesResponse;
	/** Names of selected Slack channels the bot is not a member of, from the Slack channel list. */
	botMissing: readonly string[];
	runner: RunnerReading;
}

/** Selected Slack grants whose channel the bot has not joined (a post there fails). Unknown channels are not flagged here. */
export function slackChannelsBotMissing(channels: InstanceReleaseNotesResponse["effective"]["channels"], listed: ReadonlyArray<{ id: string; isMember?: boolean }> | null | undefined): string[] {
	if (!listed) return [];
	return channels.filter((c) => c.provider === "slack" && c.selected && listed.some((l) => l.id === c.channelId && l.isMember === false)).map((c) => c.name);
}

/**
 * Whether a production note can reach a channel, and if not, every reason found. Fail-closed: "ready"
 * is what is left when nothing is wrong, so a new or unreadable state cannot read as ready.
 */
export function readiness({ view, botMissing, runner }: ReadinessInput): Readiness {
	const items: Readiness["items"] = [];
	const { effective, gate } = view;
	if (!effective.enabled) items.push({ id: "off", text: "Release notes are off for this agent, so nothing is posted." });
	if (effective.channels.length === 0) items.push({ id: "no_channel", text: "No channel is granted. Grant a Slack or Discord channel below." });
	else if (!effective.channels.some((c) => c.selected)) items.push({ id: "none_selected", text: "Channels are granted but none is selected, so nothing is posted. Tick at least one." });
	if (botMissing.length) items.push({ id: "bot_not_in_channel", text: `The Slack bot is not in ${botMissing.join(", ")}. Invite it, or the post will fail.` });
	if (gate.state === "none") items.push({ id: "no_gate", text: "No gate is configured, so notes are status notes and no deploy is verified." });
	if (gate.state === "configuration_required") items.push({ id: "gate_setup", text: "The gate has no deploy job and step, so its notes are held. Save it with both." });
	if (gate.state !== "none") {
		const warning = runnerWarning(runner);
		if (warning) items.push({ id: "runner", text: warning });
	}
	return { ready: items.length === 0, items };
}

/** The runner half: a gated push needs CLI 0.4.179+, and an old one's missing SHA cannot be recovered from branch HEAD. */
export function runnerWarning(r: RunnerReading): string | null {
	const update = `Update it with \`pags update\`. A gated push needs CLI ${MIN_GATED_RUNNER} or newer, and a missing SHA cannot be recovered from the branch head, so those notes stay held.`;
	if (!r.node) return `No runner is pinned or resolved, so its CLI version cannot be checked. Pin a machine on the Settings tab. A gated push needs CLI ${MIN_GATED_RUNNER} or newer.`;
	const cmp = r.version ? compareVersions(r.version, MIN_GATED_RUNNER) : null;
	if (cmp !== null && cmp < 0) return `The runner on ${r.node} is ${r.version}. ${update}`;
	if (r.connected !== true) return `The runner on ${r.node} is ${r.connected === false ? "offline" : "not reporting"}; start it with \`pags up\` so a push can carry its SHA.`;
	if (r.version === null) return `The runner on ${r.node} does not report its version. ${update}`;
	if (cmp === null) return `The runner on ${r.node} reports version "${r.version}", which cannot be compared with ${MIN_GATED_RUNNER}. ${update}`;
	return null;
}

/** What the panel prints after a test send. It bypassed the gate, so it must not read as a release. */
export function testSentText(channel: { provider: string; name: string }, permalink?: string): string {
	return `TEST note sent to ${channel.provider === "slack" ? "Slack" : "Discord"} ${channel.name}. It skips the workflow checks and is not a release.${permalink ? ` Message: ${permalink}` : ""}`;
}
