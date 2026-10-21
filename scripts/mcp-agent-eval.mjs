#!/usr/bin/env node
/**
 * mcp-agent-eval.mjs — the MCP agent eval (#1244), on demand.
 *
 *   node scripts/mcp-agent-eval.mjs                       # scripted corpus against this checkout (deterministic, no network)
 *   node scripts/mcp-agent-eval.mjs --ref bc9541f6        # the same corpus against an older revision, in a temporary worktree
 *   ANTHROPIC_API_KEY=… node scripts/mcp-agent-eval.mjs --driver live [--model <id>]   # a real model picks each first call
 *
 * What it measures, from workers/mcp/src/eval/ (the harness, the tasks and the scorer live there):
 *   - SCRIPTED: for each owner-shaped task, the careful call and each recorded mistake (the audit's offender shapes) are replayed
 *     through a real PagsMcp over a real client, the platform API stubbed per task. It reports what the SERVER does with each mistake:
 *     recovers it (with a note), names it (invalid_input, unknown tool, deprecated alias), or lets it fail. It does not say how often a
 *     model makes the mistakes.
 *   - LIVE: a model is given only the owner's words and the server's real tool list and chooses ONE first call per task. This is the
 *     first-call success rate #1244 asks for. It costs one request carrying every tool definition per task.
 *
 * Execution model (decided, not defaulted): the scripted run is deterministic and free, so it runs in CI as part of the unit suite
 * (workers/mcp/src/eval/eval.test.ts pins its totals). The live run is a model call per task — cost, and a different answer on a
 * different day — so it is NEVER a CI gate: run it by hand when the tool surface or descriptions change, and commit the stored result.
 *
 * Output: a table, and docs/mcp-eval/results-<driver>-<ref>-<sha>-<timestamp>.json. Exit code is non-zero if the scripted run's careful
 * calls are not all first-call successes (a task or the surface is broken); a live run never fails the exit code — it reports.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const driver = opt("driver", "scripted");
const ref = opt("ref", null);
const model = opt("model", process.env.EVAL_MODEL ?? "claude-sonnet-5-5");
const outDir = resolve(ROOT, opt("out", "docs/mcp-eval"));
if (!["scripted", "live"].includes(driver)) {
	console.error('--driver must be "scripted" or "live".');
	process.exit(2);
}
if (driver === "live" && !process.env.ANTHROPIC_API_KEY) {
	console.error("--driver live needs ANTHROPIC_API_KEY in the environment. Nothing was run and nothing was spent.");
	process.exit(2);
}

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const sha = ref ? git("rev-parse", "--short", ref) : git("rev-parse", "--short", "HEAD");
const dirty = !ref && git("status", "--porcelain", "--", "workers/mcp/src") !== "";

let cwd = ROOT;
let worktree = null;
if (ref) {
	// An older revision has none of this harness: check it out beside, copy the harness in, and share node_modules.
	worktree = mkdtempSync(join(tmpdir(), "pags-eval-"));
	rmSync(worktree, { recursive: true, force: true });
	git("worktree", "add", "--detach", worktree, ref);
	const link = (rel) => existsSync(join(ROOT, rel)) && !existsSync(join(worktree, rel)) && symlinkSync(join(ROOT, rel), join(worktree, rel));
	link("node_modules");
	for (const group of ["workers", "packages"]) for (const d of readdirSync(join(ROOT, group))) link(join(group, d, "node_modules"));
	mkdirSync(join(worktree, "workers/mcp/src/eval"), { recursive: true });
	for (const f of ["driver", "scorer", "harness", "tasks", "run.test"]) cpSync(join(ROOT, `workers/mcp/src/eval/${f}.ts`), join(worktree, `workers/mcp/src/eval/${f}.ts`));
	cwd = worktree;
}

const tmpOut = join(tmpdir(), `pags-eval-${process.pid}.json`);
try {
	execFileSync("npx", ["vitest", "run", "workers/mcp/src/eval/run.test.ts"], {
		cwd,
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, EVAL_RUN: "1", EVAL_DRIVER: driver, EVAL_OUT: tmpOut, EVAL_MODEL: model },
	});
} finally {
	if (worktree) {
		try {
			git("worktree", "remove", "--force", worktree);
		} catch {
			rmSync(worktree, { recursive: true, force: true });
		}
	}
}

const run = JSON.parse(readFileSync(tmpOut, "utf8"));
rmSync(tmpOut, { force: true });
const { report } = run;
const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "-");
const row = (name, t) => `${name.padEnd(8)} calls ${String(t.calls).padStart(3)}  first-call ${String(t.firstCallSuccess).padStart(3)} (${pct(t.firstCallSuccess, t.calls).padStart(4)})  effective ${String(t.effective).padStart(3)}  noted ${String(t.noted).padStart(3)}  deprecated ${String(t.deprecated).padStart(2)}  invalid_input ${String(t.invalidInput).padStart(2)}  unknown_tool ${String(t.unknownTool).padStart(2)}  wrong_tool ${String(t.wrongTool).padStart(3)}`;

console.log(`\nMCP agent eval — driver ${run.driver}, revision ${ref ?? "HEAD"} (${sha}${dirty ? ", uncommitted changes in workers/mcp/src" : ""}), ${run.tasks} tasks\n`);
console.log("task".padEnd(28), "variant".padEnd(32), "result");
for (const r of report.results) {
	const s = r.score;
	const kind = s.firstCallSuccess ? "first-call ok" : s.invalidInput ? "invalid_input" : s.unknownTool ? "unknown tool" : s.deprecated ? "deprecated alias" : !s.toolMatches ? `wrong tool (${s.tool})` : s.effective ? `recovered, ${s.notes} note(s)` : "refused";
	console.log(r.taskId.padEnd(28), r.variant.padEnd(32), kind);
}
console.log("");
if (report.clean.calls) console.log(row("careful", report.clean));
if (report.sloppy.calls) console.log(row("mistakes", report.sloppy));
if (report.results.some((r) => r.variant === "live")) console.log(row("live", report.all));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `results-${driver}-${ref ? `ref-${sha}` : "head"}-${sha}-${stamp}.json`);
writeFileSync(file, `${JSON.stringify({ meta: { driver: run.driver, model: driver === "live" ? model : null, revision: ref ?? "HEAD", sha, dirty, at: new Date().toISOString(), node: process.version, tasks: run.tasks }, ...report }, null, 2)}\n`);
console.log(`\nstored: ${file.replace(`${ROOT}/`, "")}`);

if (driver === "scripted" && report.clean.firstCallSuccess !== report.clean.calls) {
	console.error("\nA careful call did not succeed first time: a task's stub or the surface is broken.");
	process.exit(1);
}
