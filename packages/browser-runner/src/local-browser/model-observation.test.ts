import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexModelObserver } from "./model-observation.js";

const id = "11111111-2222-3333-4444-555555555555";
const now = Date.parse("2026-11-05T12:00:00Z");
let home: string;
let folder: string;
let cwd: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "pags-model-"))); folder = join(home, "sessions/2026/11/05"); mkdirSync(folder, { recursive: true }); cwd = join(home, "scratch"); mkdirSync(cwd); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const filename = () => join(folder, `rollout-2026-11-05T12-00-00-${id}.jsonl`);
function metadata(sessionId = id, workingDir = cwd) {
	return [{ type: "session_meta", payload: { id: sessionId, cwd: workingDir, base_instructions: "PRIVATE" } }, { type: "turn_context", payload: { cwd: workingDir, model: "future-model", effort: "high", secret: "PRIVATE" } }].map((event) => JSON.stringify(event)).join("\n") + "\n";
}
const observer = (workingDir = cwd) => { const o = new CodexModelObserver(home, workingDir, now); o.acceptLine(JSON.stringify({ type: "thread.started", thread_id: id })); return o; };

describe("observed local Codex identity (#1511)", () => {
	it("publishes only model/effort from matching thread AND working directory, once", () => {
		writeFileSync(filename(), metadata());
		const o = observer();
		expect(o.read()).toEqual({ observedModel: "future-model", observedReasoningEffort: "high", modelVerification: "local_cli_metadata", source: "codex_rollout_turn_context" });
		expect(o.read()).toBeNull();
	});
	it("can retry missing metadata without inventing observed identity", () => {
		const o = observer();
		expect(o.read()).toBeNull();
		writeFileSync(filename(), metadata());
		expect(o.read()?.observedModel).toBe("future-model");
	});
	it.each(["thread", "cwd"])("rejects mismatched %s binding", (mismatch) => {
		const other = join(home, "other-run"); mkdirSync(other);
		writeFileSync(filename(), metadata(mismatch === "thread" ? "other-thread" : id, mismatch === "cwd" ? other : cwd));
		expect(observer().read()).toBeNull();
	});
	it("ignores prose, other event types, invalid IDs and unrelated logs", () => {
		writeFileSync(filename(), metadata());
		for (const line of ["model: future-model", JSON.stringify({ type: "item.completed", thread_id: id }), JSON.stringify({ type: "thread.started", thread_id: "../../escape" })]) {
			const o = new CodexModelObserver(home, cwd, now); o.acceptLine(line); expect(o.read()).toBeNull();
		}
	});
	it.each(["expected", "reported"])("accepts a directory alias in the %s cwd without broadening thread binding", (side) => {
		const alias = join(home, "scratch-alias"); symlinkSync(cwd, alias, "dir");
		writeFileSync(filename(), metadata(id, side === "reported" ? alias : cwd));
		expect(observer(side === "expected" ? alias : cwd).read()?.observedModel).toBe("future-model");
	});
	it("refuses nonexistent paths even when their strings match", () => {
		const missing = join(home, "missing"); writeFileSync(filename(), metadata(id, missing));
		expect(observer(missing).read()).toBeNull();
	});
	it("does not rebind an expected cwd alias retargeted after launch", () => {
		const alias = join(home, "alias"); symlinkSync(cwd, alias, "dir");
		const o = observer(alias);
		const other = join(home, "other"); mkdirSync(other); rmSync(alias); symlinkSync(other, alias, "dir");
		writeFileSync(filename(), metadata(id, alias));
		expect(o.read()).toBeNull();
	});
	it("does not follow a rollout symlink", () => {
		const target = join(home, "other.jsonl"); writeFileSync(target, metadata()); symlinkSync(target, filename());
		expect(observer().read()).toBeNull();
	});
});
