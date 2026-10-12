/**
 * Deploy retry policy (#1046), against the wrangler output the failing 2026-10-12 runs actually printed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe as group, expect, it } from "vitest";
import { classifyFailure, deployWithRetry, describe, exitCodeFor, failedResources } from "./deploy-worker.mjs";
import { checkTriggers, parseWranglerConfig, withRetry } from "./verify-triggers.mjs";

// Deploy API run 38252546775 (bb7c11e0): Worker uploaded, five workflows deployed, one failed.
const PARTIAL_TRIGGERS = `Uploaded proagentstore-api (5.76 sec)
Deployed proagentstore-api triggers (74.29 sec)
  api.proagentstore.online (custom domain - zone name: proagentstore.online)
  schedule: * * * * *
  workflow: pags-coding-session
  workflow: pags-pipeline-run
  workflow: pags-browser-task
  workflow: pags-agent-loop
  workflow: pags-runner-update

✘ [ERROR] Some triggers failed to deploy for proagentstore-api:

    - A request to the Cloudflare API (/accounts/***/workflows/pags-job-apply) failed.
`;
// Deploy API run 38254477274 (9ad8adf9), and Deploy MCP runs 38254477330 / 38248512223.
const MALFORMED = `Uploaded proagentstore-api (116.67 sec)
✘ [ERROR] Received a malformed response from the API
`;
const AUTH = `✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/scripts/proagentstore-api) failed.

  Authentication error [code: 10000]
`;
const VALIDATION = `✘ [ERROR] A request to the Cloudflare API (/accounts/***/workers/scripts/proagentstore-api) failed.

  Uncaught Error: No such module "node:missing". [code: 10021]
`;
const BUILD = `✘ [ERROR] Build failed with 1 error:
  src/index.ts:1:20: ERROR: Could not resolve "./nope.js"
`;

const noSleep = async () => {};
const scripted = (outputs) => {
	const calls = [];
	const attempt = async (n) => {
		calls.push(n);
		return outputs[n - 1];
	};
	return { calls, attempt };
};

group("classifyFailure (#1046)", () => {
	it("retries the two failures the runs hit: a partial trigger deploy and a malformed API response", () => {
		expect(classifyFailure(PARTIAL_TRIGGERS)).toBe("transient");
		expect(classifyFailure(MALFORMED)).toBe("transient");
	});

	it("retries Cloudflare 5xx/429 and network resets", () => {
		expect(classifyFailure("✘ [ERROR] 503 Service Unavailable")).toBe("transient");
		expect(classifyFailure("✘ [ERROR] 429 Too Many Requests")).toBe("transient");
		expect(classifyFailure("TypeError: fetch failed\n  cause: Error: read ECONNRESET")).toBe("transient");
		expect(classifyFailure("A request to the Cloudflare API (/x) failed.\n  An unknown error occurred [code: 10013]")).toBe("transient");
	});

	it("never retries auth, validation or build errors — even behind the same 'A request … failed' line", () => {
		expect(classifyFailure(AUTH)).toBe("hard");
		expect(classifyFailure(VALIDATION)).toBe("hard");
		expect(classifyFailure(BUILD)).toBe("hard");
		expect(classifyFailure("something nobody has seen before")).toBe("hard");
	});

	it("names the resource that failed", () => {
		expect(failedResources(PARTIAL_TRIGGERS)).toEqual(["workflow pags-job-apply"]);
		expect(failedResources(MALFORMED)).toEqual([]);
	});
});

group("deployWithRetry (#1046)", () => {
	it("transient, then success: deployed_after_retry after backing off", async () => {
		const run = scripted([{ code: 1, output: PARTIAL_TRIGGERS }, { code: 0, output: "Uploaded" }]);
		const waits = [];
		const r = await deployWithRetry({ attempt: run.attempt, sleep: async (ms) => waits.push(ms), backoff: [20_000, 60_000] });
		expect(r.status).toBe("deployed_after_retry");
		expect(run.calls).toEqual([1, 2]);
		expect(waits).toEqual([20_000]);
	});

	it("transient every time: bounded at 3 attempts, retryable_failure, red", async () => {
		const run = scripted([{ code: 1, output: PARTIAL_TRIGGERS }, { code: 1, output: MALFORMED }, { code: 1, output: PARTIAL_TRIGGERS }, { code: 0, output: "" }]);
		const waits = [];
		const r = await deployWithRetry({ attempt: run.attempt, sleep: async (ms) => waits.push(ms), backoff: [20_000, 60_000] });
		expect(r.status).toBe("retryable_failure");
		expect(run.calls).toEqual([1, 2, 3]);
		expect(waits).toEqual([20_000, 60_000]);
		expect(exitCodeFor(r.status)).toBe(1);
	});

	it("a hard failure is never retried, even after a transient one", async () => {
		const first = scripted([{ code: 1, output: AUTH }]);
		expect((await deployWithRetry({ attempt: first.attempt, sleep: noSleep })).status).toBe("failed");
		expect(first.calls).toEqual([1]);
		const later = scripted([{ code: 1, output: MALFORMED }, { code: 1, output: BUILD }, { code: 0, output: "" }]);
		expect((await deployWithRetry({ attempt: later.attempt, sleep: noSleep })).status).toBe("failed");
		expect(later.calls).toEqual([1, 2]);
	});

	it("first-try success is plain deployed", async () => {
		const run = scripted([{ code: 0, output: "" }]);
		expect((await deployWithRetry({ attempt: run.attempt, sleep: noSleep })).status).toBe("deployed");
	});
});

group("status → exit code and report (#1046)", () => {
	it("only a finished deploy is green", () => {
		expect(exitCodeFor("deployed")).toBe(0);
		expect(exitCodeFor("deployed_after_retry")).toBe(0);
		expect(exitCodeFor("failed")).toBe(1);
		expect(exitCodeFor("retryable_failure")).toBe(1);
	});

	it("each status has its own sentence; failures are ::error, a recovered deploy a ::warning", () => {
		const transient = { kind: "transient", resources: ["workflow pags-job-apply"] };
		expect(describe("proagentstore-api", { status: "deployed", attempts: [{ kind: "ok" }] })).toEqual({ line: "proagentstore-api: deployed.", annotation: null });
		const after = describe("proagentstore-api", { status: "deployed_after_retry", attempts: [transient, { kind: "ok" }] });
		expect(after.annotation).toMatch(/^::warning /);
		expect(after.line).toContain("workflow pags-job-apply");
		const retryable = describe("proagentstore-api", { status: "retryable_failure", attempts: [transient, transient, transient] });
		expect(retryable.annotation).toMatch(/^::error title=proagentstore-api deploy: retryable_failure::/);
		expect(retryable.line).toMatch(/NOT confirmed deployed.*re-run/);
		expect(describe("proagentstore-api", { status: "failed", attempts: [{ kind: "hard", resources: [] }] }).annotation).toMatch(/^::error title=proagentstore-api deploy: failed::/);
	});
});

group("trigger verification (#1046)", () => {
	const config = parseWranglerConfig(readFileSync(resolve(import.meta.dirname, "../../workers/api/wrangler.toml"), "utf8"));
	const live = (overrides = {}) => async (name) => {
		if (name in overrides) return overrides[name];
		const wf = config.workflows.find((w) => w.name === name);
		return { name, script_name: "proagentstore-api", class_name: wf.className };
	};

	it("reads the six workflows, their classes and the cron from the real wrangler.toml", () => {
		expect(config.name).toBe("proagentstore-api");
		expect(config.crons).toEqual(["* * * * *"]);
		expect(config.workflows.map((w) => w.name)).toEqual(["pags-job-apply", "pags-coding-session", "pags-pipeline-run", "pags-browser-task", "pags-agent-loop", "pags-runner-update"]);
		expect(config.workflows[0]).toEqual({ name: "pags-job-apply", className: "JobApplyWorkflow", scriptName: "proagentstore-api" });
	});

	it("passes only when every workflow is bound to this script and class and the crons match", async () => {
		const r = await checkTriggers(config, { getWorkflow: live(), getSchedules: async () => ["* * * * *"] });
		expect(r.ok).toBe(true);
		expect(r.rows).toHaveLength(7);
	});

	it("catches a missing workflow, a workflow on another script, and a changed cron", async () => {
		const r = await checkTriggers(config, {
			getWorkflow: live({ "pags-job-apply": null, "pags-agent-loop": { name: "pags-agent-loop", script_name: "old-api", class_name: "AgentLoopWorkflow" } }),
			getSchedules: async () => [],
		});
		expect(r.ok).toBe(false);
		const byTrigger = Object.fromEntries(r.rows.map((x) => [x.trigger, x.state]));
		expect(byTrigger["workflow pags-job-apply"]).toBe("missing");
		expect(byTrigger["workflow pags-agent-loop"]).toBe("wrong");
		expect(byTrigger.crons).toBe("wrong");
		expect(byTrigger["workflow pags-coding-session"]).toBe("ok");
	});

	it("a read that fails is unverified — red, never a pass", async () => {
		const r = await checkTriggers(config, {
			getWorkflow: live(),
			getSchedules: async () => {
				throw new Error("HTTP 502");
			},
		});
		expect(r.ok).toBe(false);
		expect(r.rows.find((x) => x.trigger === "crons")).toMatchObject({ state: "unverified", detail: "HTTP 502" });
	});

	it("withRetry re-reads a failed Cloudflare read, then gives up with the last error", async () => {
		let n = 0;
		expect(await withRetry(async () => (++n < 2 ? Promise.reject(new Error("blip")) : "ok"), { sleep: noSleep })).toBe("ok");
		await expect(withRetry(async () => Promise.reject(new Error("down")), { sleep: noSleep })).rejects.toThrow("down");
	});
});
