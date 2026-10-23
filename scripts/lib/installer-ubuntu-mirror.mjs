import { readFileSync } from "node:fs";
import { runBoundedCommand } from "./installer-process-tree.mjs";

const FILES = ["/etc/apt/apt-mirrors.txt", "/etc/apt/sources.list.d/ubuntu.sources"];
export function officialUbuntuMirror(text) {
	return text.split("\n").map((line) => line.trimStart().startsWith("#") ? line : line.replace(/https?:\/\/azure\.archive\.ubuntu\.com(?=\/ubuntu(?:\/|\s|$))/g, "https://archive.ubuntu.com")).join("\n");
}

/** Only the ephemeral GitHub-hosted Linux VM may change its existing Ubuntu mirror after a retry. */
export async function useHostedUbuntuArchive({ env = process.env, platform = process.platform, read = (file) => readFileSync(file, "utf8"), write, log = console.log } = {}) {
	if (platform !== "linux" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted") return [];
	const update = write || ((file, text) => runBoundedCommand("sudo", ["-n", "python3", "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())", file], { input: text, rejectNonzero: true }));
	const changed = [];
	for (const file of FILES) {
		let previous;
		try { previous = read(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
		const next = officialUbuntuMirror(previous);
		if (next === previous) continue;
		await update(file, next);
		changed.push(file);
		log(`[install] retry uses the official HTTPS Ubuntu archive in ${file}; suites, components and verification preserved`);
	}
	return changed;
}
