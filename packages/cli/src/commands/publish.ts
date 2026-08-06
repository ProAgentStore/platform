import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { writeError, writeLine } from "../output.js";

export const publishCommand = new Command("publish")
	.description("Publish an agent to ProAgentStore")
	.option("-d, --dir <path>", "Agent directory", ".")
	.action(async (opts: { dir: string }) => {
		const dir = resolve(opts.dir);

		// Read manifest
		const manifestPath = join(dir, "agent.json");
		if (!existsSync(manifestPath)) {
			writeError("No agent.json found. Run `pags init` first.");
			process.exit(1);
		}
		// A hand-edited agent.json is external data: parsed bare, a stray comma ended the
		// publish with a raw SyntaxError stack and no mention of which file was at fault.
		let manifest: { id?: string; name?: string };
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		} catch (e) {
			writeError(`agent.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
			process.exit(1);
			return;
		}
		const slug = manifest.id;
		if (!slug) {
			writeError("agent.json missing id");
			process.exit(1);
		}

		writeLine(`\n  Publishing ${manifest.name} (${slug})...\n`);

		// Run compliance checks
		writeLine("  Running compliance checks...");
		try {
			execFileSync("pags", ["check"], { cwd: dir, stdio: "inherit" });
		} catch {
			writeError("\n  Compliance checks failed. Fix issues and retry.\n");
			process.exit(1);
		}

		// Check if repo exists in ProAgentStore org
		const org = "ProAgentStore";
		const repoName = slug;
		writeLine(`\n  Checking GitHub repo: ${org}/${repoName}`);

		let repoExists = false;
		try {
			execFileSync("gh", ["api", `repos/${org}/${repoName}`, "--jq", ".name"], {
				stdio: "pipe",
			});
			repoExists = true;
			writeLine("  Repo exists, pushing...");
		} catch {
			writeLine("  Creating repo...");
			try {
				execFileSync(
					"gh",
					["repo", "create", `${org}/${repoName}`, "--public", `--source=${dir}`, "--push"],
					{ stdio: "inherit" },
				);
				repoExists = true;
			} catch (e) {
				writeError(`  Failed to create repo: ${e}`);
				process.exit(1);
			}
		}

		if (repoExists) {
			// Ensure remote is set and push
			try {
				execFileSync("git", ["remote", "get-url", "origin"], {
					cwd: dir,
					stdio: "pipe",
				});
			} catch {
				execFileSync(
					"git",
					["remote", "add", "origin", `https://github.com/${org}/${repoName}.git`],
					{ cwd: dir },
				);
			}
			try {
				execFileSync("git", ["push", "-u", "origin", "main"], {
					cwd: dir,
					stdio: "inherit",
				});
			} catch (e) {
				// This used to print "Push skipped (up to date or no commits)" and carry on to
				// "Published!". `git push` with nothing to push EXITS 0 — so this branch only ever
				// ran on a real failure (rejected non-fast-forward, no auth, no network), and the
				// one message it printed was false in every case it could fire. The agent's code
				// never left the machine while the CLI said it had shipped, which is the state the
				// user then debugged on the store side.
				writeError(`\n  Push failed: ${e instanceof Error ? e.message : String(e)}`);
				writeError("  Nothing was published — fix the push (pull/rebase, or check your GitHub auth) and retry.\n");
				process.exit(1);
				return;
			}
		}

		// Register in platform D1 (via API)
		writeLine("\n  Registering agent in store...");
		// TODO: call POST /v1/agents with agent.json data
		// For now, agents are registered via the Console UI

		writeLine(`\n  Published! ${slug}.proagentstore.online`);
		writeLine(`  Store: https://proagentstore.online/agents/${slug}/`);
		writeLine(`  Repo:  https://github.com/${org}/${repoName}`);
		writeLine();
	});
