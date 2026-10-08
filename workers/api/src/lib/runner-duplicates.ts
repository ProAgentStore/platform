/**
 * Two `pags up` processes on one machine, named rather than suspected (#896).
 *
 * ── What this answers, and why nothing could before
 *
 * On 2026-10-01 three `pags up` processes were running on one laptop. Only one owned the relay link
 * for the coders; that link wedged (`relayConnected: true` while its health check timed out), every
 * coding call came back 504, a run failed and the work queue lost an entry. The platform could not
 * say any of that, because nothing identified a runner PROCESS: heartbeats, registrations and relay
 * sockets all carried only `(instance, node)`, so three processes looked exactly like one. The
 * console's advice was "restart `pags up`" — which, with `pkill` still in the start path, was how
 * the next duplicate got made.
 *
 * ── The signal, and why it needs no migration
 *
 * Every heartbeat already carries the runner PROCESS's own `startedAt` (#924), stored per
 * `instance_runtime_nodes` row in `resources`. Two processes on one machine serve different agents,
 * so their samples land in different rows — and two distinct `startedAt` values heartbeating for
 * one `(user, machine)` inside the freshness window IS the duplicate. From #896's CLI on the
 * samples also carry `rsid`, `pid` and `launch`, which turns "there are two" into "there are these
 * two, and here is where each one lives".
 *
 * ── What it deliberately does not do
 *
 * It never acts. The issue's rule is that no process is killed from the outside by default, so this
 * reports and the owner decides — `pags up --replace` on the one they want, or `pags down`. It also
 * never treats SLOW as duplicate: the only input is heartbeats, and a loaded or sleeping machine
 * with one runner produces exactly one identity (#913, #922, #924).
 */

/** One runner process's heartbeat, as a row's `resources` sample reports it. */
export interface RunnerProcessIdentity {
	/** The agent whose row carried this sample — which process serves what. */
	instanceId: string;
	node: string;
	/** The runner process's own start (ms epoch) — the identity an older CLI gives us. */
	startedAt: number;
	/** The process's own id, from #896's lock. Absent on a CLI that predates it. */
	rsid?: string;
	pid?: number;
	launch?: string;
	/** When this sample was taken (ms epoch). */
	sampledAt: number;
}

export interface DuplicateRunner {
	/** `rsid` when the CLI reports one, else the process's start time — what made it distinct. */
	key: string;
	rsid: string | null;
	pid: number | null;
	launch: string | null;
	startedAt: string;
	/** The agents this process is heartbeating for. */
	instanceIds: string[];
}

export interface DuplicateVerdict {
	duplicate: boolean;
	processes: DuplicateRunner[];
	/** The sentence a console or an MCP reader shows. "" when there is nothing to report. */
	detail: string;
}

/**
 * How recent a heartbeat must be to count as a live process.
 *
 * 90 seconds, against a 30-second heartbeat: three missed beats. Long enough that one slow or
 * dropped heartbeat on a loaded machine cannot invent a duplicate, short enough that a process
 * which exited a minute ago is no longer blamed for one.
 */
export const DUPLICATE_WINDOW_MS = 90_000;

const launchWhere = (p: DuplicateRunner): string => {
	if (p.launch === "tmux") return "a tmux session";
	if (p.launch === "service") return "a background service";
	if (p.launch === "headless") return "headless";
	if (p.launch === "tty") return "a terminal";
	return "";
};

/** "pid 4121 (a terminal), started 09:12" — one process, as a reader needs it. */
export function describeProcess(p: DuplicateRunner): string {
	const bits = [p.pid ? `pid ${p.pid}` : p.rsid ? `runner ${p.rsid.slice(0, 8)}` : "an unidentified runner"];
	const where = launchWhere(p);
	if (where) bits.push(`in ${where}`);
	bits.push(`started ${p.startedAt}`);
	return bits.join(", ");
}

/**
 * Are two or more runner processes live on this machine? PURE.
 *
 * Identity is `rsid` when the CLI reports one and the process's start time otherwise, so a mixed
 * fleet during a rollout is still counted correctly — which matters, because the machines most
 * likely to be running duplicates are the ones nobody has updated.
 */
export function detectDuplicateRunners(samples: readonly RunnerProcessIdentity[], now: number): DuplicateVerdict {
	const live = samples.filter((s) => s.startedAt > 0 && now - s.sampledAt <= DUPLICATE_WINDOW_MS);
	const byKey = new Map<string, DuplicateRunner>();
	for (const s of live) {
		const key = s.rsid?.trim() || `started:${s.startedAt}`;
		const found = byKey.get(key);
		if (found) {
			if (!found.instanceIds.includes(s.instanceId)) found.instanceIds.push(s.instanceId);
			continue;
		}
		byKey.set(key, {
			key,
			rsid: s.rsid?.trim() || null,
			pid: s.pid ?? null,
			launch: s.launch ?? null,
			startedAt: new Date(s.startedAt).toISOString(),
			instanceIds: [s.instanceId],
		});
	}
	const processes = [...byKey.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	if (processes.length < 2) return { duplicate: false, processes, detail: "" };
	const node = live[0]?.node ?? "this machine";
	return {
		duplicate: true,
		processes,
		// Named, and with the fix — "restart `pags up`" was the old advice, and following it with the
		// old CLI made a third process.
		detail: `${processes.length} \`pags up\` processes are running on ${node}: ${processes.map(describeProcess).join("; ")}. They compete for the same agents, which is how a relay link goes stale. Fix: run \`pags up --replace\` on the one you want to keep, or \`pags down\` on the others.`,
	};
}

/**
 * The verdict for ONE machine, read from the rows this account already has (#896).
 *
 * Deliberately not a new table: the runner process's own `startedAt` has ridden on every heartbeat
 * since #924 and is stored per `instance_runtime_nodes` row, so the detector needs no migration and
 * no CLI release — which matters because the machines most likely to be running duplicates are the
 * ones nobody has updated. `runnerIdentityOf` lives with the parser that owns the sample's shape.
 */
export async function duplicateRunnersOn(
	env: { DB: D1Database },
	userId: string,
	node: string,
	deps: { identityOf: (instanceId: string, node: string, raw: unknown) => RunnerProcessIdentity | null; now?: () => number },
): Promise<DuplicateVerdict> {
	const { results } = await env.DB.prepare("SELECT instance_id, runner_node, resources FROM instance_runtime_nodes WHERE user_id = ?1 AND runner_node = ?2")
		.bind(userId, node)
		.all<{ instance_id: string; runner_node: string; resources: string | null }>()
		.catch(() => ({ results: [] as Array<{ instance_id: string; runner_node: string; resources: string | null }> }));
	const samples = (results ?? []).map((r) => deps.identityOf(r.instance_id, r.runner_node, r.resources)).filter((x): x is RunnerProcessIdentity => !!x);
	return detectDuplicateRunners(samples, (deps.now ?? Date.now)());
}
