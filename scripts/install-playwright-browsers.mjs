#!/usr/bin/env node
/**
 * install-playwright-browsers.mjs — CI's Playwright browser install, bounded (#1047).
 *
 * `pnpm exec playwright install --with-deps chromium webkit` runs `apt-get` under the hood. CI run
 * 38264810876's log froze at apt `Get:60` and nothing bounded the step: a real hang there blocks the
 * job until GitHub's six-hour default, and says nothing about why. (That run did finish, in 36s —
 * the freeze was apt being quiet — which is exactly why a quiet install and a hung one must be told
 * apart in the log.)
 *
 * This runs the SAME command, with:
 *   - a per-attempt bound ({@link ATTEMPT_TIMEOUT_MS}); past it the whole process tree is killed;
 *   - a heartbeat every {@link HEARTBEAT_MS}: elapsed time and the last line seen, so a slow apt
 *     download reads as progress and a hang reads as the same line, minutes old;
 *   - diagnostics on a timeout — process tree, apt/dpkg lock holders, `dpkg --audit`, disk, and
 *     whether the apt mirror and Playwright's download hosts answer — to the log and step summary;
 *   - up to {@link MAX_ATTEMPTS} attempts. `playwright install` is idempotent; a killed apt can leave
 *     dpkg half-configured, so `sudo dpkg --configure -a` runs before each retry.
 * Both browsers, always: E2E coverage is never reduced to get green. Exhausted attempts are red.
 *
 * Run: node scripts/install-playwright-browsers.mjs
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runBoundedCommand, terminateInstallerTree } from "./lib/installer-process-tree.mjs";
import { useHostedUbuntuArchive } from "./lib/installer-ubuntu-mirror.mjs";

export const INSTALL_COMMAND = ["pnpm", ["exec", "playwright", "install", "--with-deps", "chromium", "webkit"]];
export const ATTEMPT_TIMEOUT_MS = 480_000;
export const HEARTBEAT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;

/** What a stalled install is diagnosed with. Each is bounded and best-effort; none can fail the step. */
export const DIAGNOSTICS = [
	["process tree", "ps -eo pid,ppid,etime,stat,args --forest | grep -v ' \\[' | tail -n 60"],
	["apt/dpkg lock holders", "sudo fuser -v /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>&1 || echo 'no process holds an apt/dpkg lock'"],
	["dpkg --audit", "sudo dpkg --audit 2>&1 || true"],
	["disk", "df -h / /tmp 2>&1"],
	[
		"apt mirror connectivity",
		"for u in $(grep -rhoE 'https?://[^ ]+' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | sort -u | head -n 3); do printf '%s ' \"$u\"; curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' --max-time 10 \"$u\" 2>&1; done",
	],
	[
		"Playwright download connectivity",
		"for u in https://cdn.playwright.dev https://playwright.download.prss.microsoft.com; do printf '%s ' \"$u\"; curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' --max-time 10 \"$u\" 2>&1; done",
	],
];

const mmss = (ms) => `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

/**
 * One attempt: start it, stream its output, beat every `heartbeatMs`, and kill the tree past
 * `timeoutMs`. Resolves `{ outcome: "ok" | "failed" | "timed_out", code, lastLine }`.
 */
export function runAttempt(n, deps) {
	const { start, killTree, log, now, timers, timeoutMs, heartbeatMs } = deps;
	return new Promise((resolve) => {
		const startedAt = now();
		let lastLine = "(no output yet)";
		let lastLineAt = startedAt;
		let done = false;
		const child = start();
		const onData = (chunk) => {
			const lines = String(chunk).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
			if (lines.length) {
				lastLine = lines.at(-1);
				lastLineAt = now();
			}
			deps.write(String(chunk));
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const finish = (result) => {
			if (done) return;
			done = true;
			timers.clearInterval(beat);
			timers.clearTimeout(bound);
			resolve({ ...result, lastLine });
		};
		const beat = timers.setInterval(() => {
			log(`[install attempt ${n}] ${mmss(now() - startedAt)} elapsed; last output ${mmss(now() - lastLineAt)} ago: ${lastLine.slice(-200)}`);
		}, heartbeatMs);
		const bound = timers.setTimeout(() => {
			log(`[install attempt ${n}] no finish after ${mmss(timeoutMs)} — killing the install's process tree.`);
			try {
				killTree(child);
				finish({ outcome: "timed_out", code: null });
			} catch (error) {
				child.unref?.();
				child.stdout?.destroy?.();
				child.stderr?.destroy?.();
				log(`[install] owned-process termination failed; refusing a competing retry: ${error.message}`);
				finish({ outcome: "timed_out", code: null, terminationError: error.message });
			}
		}, timeoutMs);
		child.on("error", (err) => finish({ outcome: "failed", code: null, error: err.message }));
		child.on("close", (code) => finish(code === 0 ? { outcome: "ok", code } : { outcome: "failed", code }));
	});
}

/**
 * The whole install: attempts, diagnostics after a timeout, the dpkg repair before a retry.
 * Returns `{ status: "installed" | "installed_after_retry" | "failed", attempts, exitCode }`.
 */
export async function installBrowsers(deps) {
	const { log, summary, diagnose, heal, maxAttempts = MAX_ATTEMPTS } = deps;
	const attempts = [];
	for (let n = 1; n <= maxAttempts; n++) {
		if (n > 1) {
			log(`[install] repairing any half-configured dpkg state before attempt ${n}: sudo dpkg --configure -a`);
			await heal();
		}
		log(`[install] attempt ${n} of ${maxAttempts}: ${INSTALL_COMMAND[0]} ${INSTALL_COMMAND[1].join(" ")}`);
		const result = await runAttempt(n, deps);
		attempts.push(result);
		if (result.outcome === "ok") {
			const status = n === 1 ? "installed" : "installed_after_retry";
			log(`[install] ${status} on attempt ${n}.`);
			if (n > 1) summary(`**Playwright browser install:** \`${status}\` on attempt ${n} of ${maxAttempts}.\n`);
			return { status, attempts, exitCode: 0 };
		}
		if (result.outcome === "timed_out") {
			const report = await diagnose();
			log(`[install] diagnostics after attempt ${n} timed out:\n${report}`);
			summary(`**Playwright browser install attempt ${n} timed out** (last output: \`${result.lastLine.slice(-200).replace(/`/g, "'")}\`)\n\n\`\`\`\n${report}\n\`\`\`\n`);
		} else {
			log(`[install] attempt ${n} failed (exit ${result.code ?? result.error ?? "unknown"}); last output: ${result.lastLine}`);
		}
		if (result.terminationError) break;
	}
	const how = attempts.map((a, i) => `${i + 1}: ${a.outcome}${a.code != null ? ` (exit ${a.code})` : ""}`).join(", ");
	const where = attempts.some((a) => a.outcome === "timed_out") ? "see the diagnostics above" : "see each attempt's output above";
	log(`::error title=Playwright browser install failed::No install of chromium + webkit finished in ${attempts.length} attempts (${how}). E2E needs both; ${where}.`);
	summary(`**Playwright browser install: \`failed\`** after ${maxAttempts} attempts (${how}).\n`);
	return { status: "failed", attempts, exitCode: 1 };
}

/** Run every diagnostic, each bounded; a diagnostic that fails says so instead of failing the step. */
export async function runDiagnostics(execFn) {
	const parts = [];
	for (const [title, cmd] of DIAGNOSTICS) {
		const out = await execFn(cmd).catch((e) => `(could not run: ${e.message})`);
		parts.push(`── ${title}\n${String(out).trim() || "(no output)"}`);
	}
	return parts.join("\n");
}

const shell = (cmd) => runBoundedCommand("/bin/sh", ["-c", cmd], { timeoutMs: DIAGNOSTIC_TIMEOUT_MS });

async function main() {
	const result = await installBrowsers({
		start: () => spawn(INSTALL_COMMAND[0], INSTALL_COMMAND[1], { stdio: ["ignore", "pipe", "pipe"], detached: true }),
		// sudo may create a separate session: a group kill alone leaves root apt alive.
		killTree: terminateInstallerTree,
		write: (s) => process.stdout.write(s),
		log: (line) => console.log(line),
		summary: (md) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`),
		diagnose: () => runDiagnostics(shell),
		heal: async () => {
			await runBoundedCommand("sudo", ["-n", "dpkg", "--configure", "-a"], { rejectNonzero: true });
			await useHostedUbuntuArchive();
		},
		now: Date.now,
		timers: { setTimeout, clearTimeout, setInterval, clearInterval },
		timeoutMs: ATTEMPT_TIMEOUT_MS,
		heartbeatMs: HEARTBEAT_MS,
	});
	process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`::error title=install-playwright-browsers::${error.message}`);
		process.exitCode = 1;
	});
}
