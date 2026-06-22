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
}

export function clearScreen(): void {
	console.clear();
}

export function printLogo(): void {
	console.log("");
	for (const line of LOGO) {
		console.log(pad + c(line));
	}
	console.log("");
}

export function printStatus(state: TuiState): void {
	clearScreen();
	printLogo();

	const statusIcon = (s: string) => {
		if (s === "online" || s === "registered") return chalk.green("●");
		if (s === "starting" || s === "pending") return chalk.yellow("◉");
		if (s === "error" || s === "failed") return chalk.red("●");
		return d("○");
	};

	const statusText = (s: string) => {
		if (s === "online" || s === "registered") return chalk.green(s);
		if (s === "starting" || s === "pending") return chalk.yellow(s);
		if (s === "error" || s === "failed") return chalk.red(s);
		return d(s);
	};

	console.log(pad + d("User     ") + w(state.user));
	console.log(pad + d("Instance ") + w(state.activeInstance));
	console.log(pad + d("Runner   ") + statusIcon(state.runner) + " " + statusText(state.runner));
	console.log(pad + d("Tunnel   ") + statusIcon(state.tunnel) + " " + statusText(state.tunnel));
	console.log(pad + d("PAGS     ") + statusIcon(state.registration) + " " + statusText(state.registration));
	if (state.tunnelUrl) {
		console.log(pad + d("URL      ") + c(state.tunnelUrl));
	}
	console.log("");
	if (state.lastEvent) {
		console.log(pad + d("Last: ") + d(state.lastEvent));
	}
	console.log("");
	console.log(
		pad +
		c("r") + d(" Refresh  ") +
		c("l") + d(" Logs  ") +
		c("q") + d(" Quit"),
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
