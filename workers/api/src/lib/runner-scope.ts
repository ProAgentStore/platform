/**
 * What a runner-only sign-in may call (#1192).
 *
 * A coding engine runs as the same OS user as `pags up` and can read the session file it keeps. That cannot be prevented from
 * here, so the session a machine keeps can be made worth less: a `runner`-scoped session (a device sign-in the owner approved as
 * "runner only") is refused on every route that is not one a runner itself calls. Stolen, it can act as that runner — register,
 * heartbeat, ask for relay tokens — and nothing of the account: no agents, billing, keys, secrets or profile. It is also
 * one machine's credential (#1184), revoked on its own.
 *
 * An ALLOWLIST, so a new route is closed to it until someone decides otherwise. Every entry is a call the CLI makes while
 * running `pags up` / `runner connect` / the watchdog (grep `requestPags` and `fetch(` in packages/cli/src).
 */
export const RUNNER_SCOPE = "runner" as const;

const seg = "[^/]+";
const RULES: Array<[method: string, path: RegExp]> = [
	["GET", /^\/v1\/instances\/my\/instances$/],
	["POST", new RegExp(`^/v1/instances/${seg}/runtime$`)],
	["POST", new RegExp(`^/v1/instances/${seg}/runtime/heartbeat$`)],
	["GET", new RegExp(`^/v1/instances/${seg}/runtime/status$`)],
	["POST", new RegExp(`^/v1/relay/${seg}/token$`)],
	["GET", new RegExp(`^/v1/relay/${seg}/status$`)],
	["POST", /^\/v1\/errors\/runner-crashes$/],
	["GET", /^\/v1\/terminals\/nodes$/], // the machine-name claim reads the fleet's names (machine-claim.ts)
	["POST", new RegExp(`^/v1/terminals/nodes/${seg}/claim$`)],
	["GET", new RegExp(`^/v1/terminals/machines/${seg}/thresholds$`)],
	["POST", new RegExp(`^/v1/terminals/machines/${seg}/watchdog/heartbeat$`)],
	["GET", new RegExp(`^/v1/terminals/machines/${seg}/watchdog$`)],
	["POST", /^\/v1\/auth\/session\/refresh$/],
	["GET", /^\/v1\/auth\/me$/],
];

/** Whether a runner-scoped session may call this route. */
export function runnerRouteAllowed(method: string, path: string): boolean {
	const m = method.toUpperCase();
	const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
	return RULES.some(([rm, re]) => rm === m && re.test(p));
}

/** The 403's words: what happened and how to get a session that can. */
export const RUNNER_SCOPE_DENIED =
	"This sign-in is runner-only: it can run `pags up` on its machine but not manage the account. Sign in with `pags login` (a browser) on a machine you use yourself for that.";
