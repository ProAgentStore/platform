import { execFileSync, spawn, spawnSync } from "node:child_process";

function snapshot() {
	return execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
}

export function installerDescendants(root, table) {
	if (!Number.isSafeInteger(root) || root <= 1) throw new Error("Invalid installer PID");
	const rows = table.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
	const owned = new Set([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, parent] of rows) {
			if (pid > 1 && owned.has(parent) && !owned.has(pid)) {
				owned.add(pid);
				changed = true;
			}
		}
	}
	return [...owned];
}

function signalOwned(pids, signal) {
	const privileged = [];
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if (error.code === "EPERM") privileged.push(pid);
			else if (error.code !== "ESRCH") throw error;
		}
	}
	if (!privileged.length) return;
	const result = spawnSync("sudo", ["-n", "kill", `-${signal.replace("SIG", "")}`, "--", ...privileged.map(String)], {
		timeout: 5000, encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`Cannot signal owned installer descendants: ${result.error?.message || result.stderr.trim()}`);
}

/** Positive PIDs proven by ancestry, including children that sudo moves into a new process group. */
export function terminateInstallerTree(child, deps = {}) {
	const read = deps.snapshot || snapshot;
	const signal = deps.signal || signalOwned;
	const owned = new Set();
	try {
		// Freeze before killing parents so children cannot be reparented out of our evidence.
		// Re-read after freezing to include a child forked while the first snapshot was taken.
		for (let pass = 0; pass < 3; pass++) {
			const added = installerDescendants(child.pid, read()).filter((pid) => !owned.has(pid));
			if (!added.length) {
				signal([...owned].reverse(), "SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
				return;
			}
			for (const pid of added) owned.add(pid);
			signal(added, "SIGSTOP");
		}
		throw new Error("Installer ancestry did not settle after freezing");
	} catch (error) {
		// A failed termination must not leave processes frozen or start a competing apt retry.
		try { signal([...owned], "SIGCONT"); } catch {}
		throw error;
	}
}

/** Bound diagnostic/repair shells too: shell-only timeout signals leave descendants holding pipes. */
export function runBoundedCommand(command, args, { timeoutMs = 15000, input, rejectNonzero = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let output = "";
		let finished = false;
		const finish = (note = "", error = false) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (error) reject(new Error(`${output}${note}`));
			else resolve(`${output}${note}`);
		};
		const timer = setTimeout(() => {
			try {
				terminateInstallerTree(child);
				finish(`(timed out after ${timeoutMs}ms; owned descendants terminated)`, rejectNonzero);
			} catch (error) {
				child.unref();
				child.stdout.destroy();
				child.stderr.destroy();
				finish(`(termination failed: ${error.message})`, true);
			}
		}, timeoutMs);
		const collect = (chunk) => { output += String(chunk); };
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => finish(`(could not start: ${error.message})`));
		child.on("close", (code) => finish(code && (!output || rejectNonzero) ? `(exit ${code})` : "", rejectNonzero && code !== 0));
		if (input !== undefined) {
			child.stdin.on("error", (error) => finish(`(stdin failed: ${error.message})`, true));
			child.stdin.end(input);
		}
	});
}
