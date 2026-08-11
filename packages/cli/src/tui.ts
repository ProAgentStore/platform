import chalk from "chalk";
import { hostname } from "node:os";
import readline from "node:readline";

const ACCENT = "#7c3aed";
const c = chalk.hex(ACCENT);
const d = chalk.dim;
const w = chalk.white;
const pad = "  ";

const LOGO = [
	"██████╗  █████╗  ██████╗ ███████╗",
	"██╔══██╗██╔══██╗██╔════╝ ██╔════╝",
	"██████╔╝███████║██║  ███╗███████╗",
	"██╔═══╝ ██╔══██║██║   ██║╚════██║",
	"██║     ██║  ██║╚██████╔╝███████║",
	"╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

export interface TuiState {
	user: string;
	instances: Array<{ id: string; name: string }>;
	activeInstance: string;
	runner: "starting" | "online" | "offline" | "error";
	tunnel: "starting" | "online" | "offline" | "error";
	tunnelUrl: string;
	registration: "pending" | "registered" | "failed";
	/**
	 * The heartbeat is what keeps the console's badge online, and it fails and recovers on its
	 * own 30s cycle. It used to be reported THROUGH `registration` — a blip put a permanent
	 * "not registered" next to a machine that was fine, because the recovery line matched no
	 * branch and nothing else could clear the ✗ (#497).
	 */
	heartbeat?: "ok" | "failing";
	lastEvent: string;
	taskCount: number;
	version?: string;
	/** ms epoch when `pags up` started — the elapsed clock in the "still connecting" line. */
	startedAt?: number;
}

export function clearScreen(): void {
	console.clear();
}

export function printLogo(version?: string): void {
	console.log("");
	for (const line of LOGO) {
		console.log(pad + c(line));
	}
	console.log(pad + d("  Browser runner") + (version ? d(`  ·  v${version}`) : ""));
	console.log("");
}

// Plain-language label + one-line explanation for each connection step, so a
// non-developer understands what's happening instead of reading "● online".
const STATUS_ROWS: Record<string, { label: string; ok: string; busy: string; bad: string }> = {
	runner: { label: "Browser", ok: "running on your computer", busy: "starting up…", bad: "stopped — press r to retry" },
	tunnel: { label: "Secure link", ok: "connected to ProAgentStore", busy: "opening…", bad: "offline" },
	pags: { label: "ProAgentStore", ok: "connected — ready for jobs", busy: "registering…", bad: "not registered (retries automatically)" },
};

/**
 * Widest label plus a gap, derived rather than typed.
 *
 * It was `padEnd(13)`, and `"ProAgentStore".length` is exactly 13 — so that one row padded by
 * nothing and rendered as `ProAgentStorenot registered`. "Browser" and "Secure link" are shorter,
 * which is why only the row a worried user reads most carefully was the broken one (#497).
 */
export const LABEL_WIDTH = Math.max(...Object.values(STATUS_ROWS).map((r) => r.label.length)) + 2;

export function describe(kind: "runner" | "tunnel" | "pags", s: string): { icon: string; label: string; note: string } {
	const ok = s === "online" || s === "registered";
	const busy = s === "starting" || s === "pending";
	const icon = ok ? chalk.green("✓") : busy ? chalk.yellow("…") : chalk.red("✗");
	const m = STATUS_ROWS[kind];
	return { icon, label: m.label, note: ok ? m.ok : busy ? m.busy : m.bad };
}

/**
 * What to say while the lights are not all green.
 *
 * "this takes a few seconds" was printed on every non-connected render, with no elapsed input and
 * no timer — so a state that is permanent (a registration lost at boot, before it retried on
 * reconnect) described itself as taking a few seconds, forever. Past the point where "a few
 * seconds" stops being true, say how long it has actually been and where the logs are.
 */
export function connectingNote(elapsedMs: number): string {
	if (elapsedMs < 30_000) return "Setting things up… this takes a few seconds. Keep this window open.";
	const mins = Math.floor(elapsedMs / 60_000);
	const elapsed = mins >= 1 ? `${mins}m` : `${Math.floor(elapsedMs / 1000)}s`;
	return `Still connecting — ${elapsed} elapsed. Press l for logs.`;
}

/** The ProAgentStore row's note, which has TWO independent facts behind it (#497). */
export function pagsNote(registration: string, heartbeat: "ok" | "failing" | undefined): string | undefined {
	if (registration !== "registered" || heartbeat !== "failing") return undefined;
	// Registered, but the beat that keeps the console's badge alive is missing: the console says
	// OFFLINE while this pane says connected, and the documented remedy for that banner is
	// `--force`, which suspends other machines' sessions. Naming it here is what stops that.
	return "registered — but the heartbeat is failing, so the website reads this machine as offline";
}

export function printStatus(state: TuiState): void {
	clearScreen();
	printLogo(state.version);

	const connected = state.runner === "online" && state.tunnel === "online" && state.registration === "registered";

	console.log(pad + d("Signed in as ") + w(state.user) + d("  ·  agent: ") + w(state.activeInstance) + d("  ·  node: ") + w(hostname()));
	console.log("");

	const row = (kind: "runner" | "tunnel" | "pags", s: string, override?: string) => {
		const { icon, label, note } = describe(kind, s);
		console.log(pad + icon + " " + w(label.padEnd(LABEL_WIDTH)) + d(override ?? note));
	};
	row("runner", state.runner);
	row("tunnel", state.tunnel);
	row("pags", state.registration, pagsNote(state.registration, state.heartbeat));
	console.log("");

	if (connected) {
		console.log(pad + chalk.green("✓ You're all set!") + d(" Your agent can now act on the web."));
		console.log("");
		console.log(pad + w("What to do next:"));
		console.log(pad + d("  1. Open  ") + c("https://proagentstore.online/console"));
		console.log(pad + d("  2. Pick your agent and paste a job link to apply"));
		console.log(pad + d("  3. Keep ") + w("this window open") + d(" while your agent works"));
		console.log("");
		console.log(pad + d("The website can take a few seconds to show “online” — that's normal."));
	} else {
		console.log(pad + d(connectingNote(state.startedAt ? Date.now() - state.startedAt : 0)));
		if (state.lastEvent) console.log(pad + d("Status: ") + d(state.lastEvent));
	}
	console.log("");
	console.log(
		pad +
		c("r") + d(" Reconnect   ") +
		c("l") + d(" View logs   ") +
		c("q") + d(" Quit (disconnect)"),
	);
	console.log("");
}

export function printEvent(msg: string): void {
	const time = new Date().toTimeString().slice(0, 8);
	console.log(pad + d(time) + " " + msg);
}

export function printStep(label: string, status: "ok" | "fail" | "wait"): void {
	const icon = status === "ok" ? chalk.green("✓") : status === "fail" ? chalk.red("✗") : chalk.yellow("…");
	console.log(pad + icon + " " + label);
}

/**
 * Wait for one of `keys`.
 *
 * `onInterrupt` — what to do on Ctrl+C. Raw mode disables ISIG, so Ctrl+C arrives here as a
 * KEYPRESS and the process's `SIGINT` handler never fires. `pags up` registers its shutdown on
 * SIGINT, so the default `process.exit(0)` returned the shell prompt while leaving the spawned
 * `runner connect` child alive — still holding its relay socket, still heartbeating
 * `status = 'online'`, still driving the user's real Chrome. Pressing `q` worked; Ctrl+C did not.
 */
export async function waitForKey(keys: string[], onInterrupt?: () => void): Promise<string> {
	return new Promise((resolve) => {
		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();

		const onKeypress = (str: string, key: readline.Key) => {
			if (key?.ctrl && key.name === "c") {
				cleanup();
				if (onInterrupt) {
					onInterrupt();
					return;
				}
				process.exit(0);
			}
			const val = (str || "").trim().toLowerCase();
			// Empty keys list = "any key" (so "Press any key to go back" actually
			// works). Otherwise match the char OR the key name (so Enter/Space, which
			// trim to "", are caught via key.name).
			if (keys.length === 0 || keys.includes(val) || (key?.name && keys.includes(key.name))) {
				cleanup();
				resolve(val || key?.name || "");
			}
		};

		const cleanup = () => {
			process.stdin.off("keypress", onKeypress);
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			process.stdin.pause();
		};

		process.stdin.on("keypress", onKeypress);
	});
}
