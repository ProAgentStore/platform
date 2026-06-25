import chalk from "chalk";
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
	lastEvent: string;
	taskCount: number;
	version?: string;
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
function describe(kind: "runner" | "tunnel" | "pags", s: string): { icon: string; label: string; note: string } {
	const ok = s === "online" || s === "registered";
	const busy = s === "starting" || s === "pending";
	const icon = ok ? chalk.green("✓") : busy ? chalk.yellow("…") : chalk.red("✗");
	const map: Record<string, { label: string; ok: string; busy: string; bad: string }> = {
		runner: { label: "Browser", ok: "running on your computer", busy: "starting up…", bad: "stopped — press r to retry" },
		tunnel: { label: "Secure link", ok: "connected to ProAgentStore", busy: "opening…", bad: "offline" },
		pags: { label: "ProAgentStore", ok: "connected — ready for jobs", busy: "registering…", bad: "not registered (retries automatically)" },
	};
	const m = map[kind];
	return { icon, label: m.label, note: ok ? m.ok : busy ? m.busy : m.bad };
}

export function printStatus(state: TuiState): void {
	clearScreen();
	printLogo(state.version);

	const connected = state.runner === "online" && state.tunnel === "online" && state.registration === "registered";

	console.log(pad + d("Signed in as ") + w(state.user) + d("  ·  agent: ") + w(state.activeInstance));
	console.log("");

	const row = (kind: "runner" | "tunnel" | "pags", s: string) => {
		const { icon, label, note } = describe(kind, s);
		console.log(pad + icon + " " + w(label.padEnd(13)) + d(note));
	};
	row("runner", state.runner);
	row("tunnel", state.tunnel);
	row("pags", state.registration);
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
		console.log(pad + d("Setting things up… this takes a few seconds. Keep this window open."));
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

export async function waitForKey(keys: string[]): Promise<string> {
	return new Promise((resolve) => {
		readline.emitKeypressEvents(process.stdin);
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();

		const onKeypress = (str: string, key: readline.Key) => {
			if (key?.ctrl && key.name === "c") {
				cleanup();
				process.exit(0);
			}
			const val = (str || "").trim().toLowerCase();
			if (keys.includes(val)) {
				cleanup();
				resolve(val);
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
