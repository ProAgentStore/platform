import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { installerDescendants, runBoundedCommand, terminateInstallerTree } from "./installer-process-tree.mjs";

describe("installer-owned process termination (#1333)", () => {
	it("bounds a real diagnostic command and preserves completed output", async () => {
		expect(await runBoundedCommand(process.execPath, ["-e", 'console.log("healthy diagnostic")'])).toContain("healthy diagnostic");
		const output = await runBoundedCommand(process.execPath, ["-e", 'console.log("stalled diagnostic");setInterval(()=>{},1000)'], { timeoutMs: 200 });
		expect(output).toContain("stalled diagnostic");
		expect(output).toContain("owned descendants terminated");
	});
	it("delivers configuration input without a shell and refuses failed or timed-out repairs", async () => {
		expect(await runBoundedCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "public mirror configuration", rejectNonzero: true })).toBe("public mirror configuration");
		await expect(runBoundedCommand(process.execPath, ["-e", "process.exit(2)"], { rejectNonzero: true })).rejects.toThrow("exit 2");
		await expect(runBoundedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100, rejectNonzero: true })).rejects.toThrow("timed out");
	});
	it("follows ancestry across sessions without selecting an unrelated package manager", () => {
		expect(installerDescendants(100, "1 0\n100 1\n200 100\n300 200\n400 1\n500 400\n")).toEqual([100, 200, 300]);
		const signals = [];
		let reads = 0;
		terminateInstallerTree({ pid: 100 }, {
			snapshot: () => ++reads === 1 ? "100 1\n200 100\n400 1" : "100 1\n200 100\n300 200\n400 1",
			signal: (pids, signal) => signals.push([pids, signal]),
		});
		expect(signals).toEqual([[[100, 200], "SIGSTOP"], [[300], "SIGSTOP"], [[300, 200, 100], "SIGKILL"]]);
	});

	it("resumes only owned processes and refuses an unsafe termination when freezing fails", () => {
		const signals = [];
		expect(() => terminateInstallerTree({ pid: 100 }, {
			snapshot: () => "100 1\n200 100\n400 1",
			signal: (pids, signal) => {
				signals.push([pids, signal]);
				if (signal === "SIGSTOP") throw new Error("permission denied");
			},
		})).toThrow("permission denied");
		expect(signals).toEqual([[[100, 200], "SIGSTOP"], [[100, 200], "SIGCONT"]]);
	});

	async function escapedGrandchild(privileged) {
		const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		const grandchildCode = 'console.log(JSON.stringify({grandchild:process.pid}));setInterval(()=>process.stdout.write("owned output\\n"),50)';
		const command = privileged ? "sudo" : process.execPath;
		const args = privileged ? ["-n", process.execPath, "-e", grandchildCode] : ["-e", grandchildCode];
		const parentCode = `require('node:child_process').spawn(${JSON.stringify(command)},${JSON.stringify(args)},{detached:true,stdio:['ignore',1,2]});setInterval(()=>{},1000)`;
		const child = spawn(process.execPath, ["-e", parentCode], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let grandchild;
		try {
			grandchild = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("No grandchild readiness receipt")), 5000);
				let output = "";
				child.stdout.on("data", (chunk) => {
					output += chunk;
					const match = /\{"grandchild":(\d+)\}/.exec(output);
					if (match) { clearTimeout(timer); resolve(Number(match[1])); }
				});
			});
			const closed = once(child, "close");
			terminateInstallerTree(child);
			await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned output pipe survived termination")), 2000))]);
			expect(child.signalCode).toBe("SIGKILL");
			expect(() => process.kill(sentinel.pid, 0)).not.toThrow();
			// A dead grandchild may briefly be an unreaped zombie; it cannot own locks or write.
			const { execFileSync } = await import("node:child_process");
			let state = "";
			try { state = execFileSync("ps", ["-p", String(grandchild), "-o", "stat="], { encoding: "utf8" }).trim(); } catch {}
			expect(state === "" || state.startsWith("Z")).toBe(true);
		} finally {
			sentinel.kill("SIGKILL");
			if (child.exitCode === null && child.signalCode === null) terminateInstallerTree(child);
		}
	}
	it("reaps a real new-session descendant retaining stdout while an unrelated process survives", async () => {
		await escapedGrandchild(false);
	}, 15000);
	it.skipIf(process.platform !== "linux" || !process.env.CI)("reaps an actual sudo-owned new-session descendant on the hosted CI runner", async () => {
		await escapedGrandchild(true);
	}, 15000);
});
