import { describe, expect, it } from "vitest";
import { SECURE_HANDOFF_MIN_CLI } from "./connectors/tmux.js";
import { ENGINE_CHECK_MIN_CLI } from "./engine-preflight.js";
import { LOCAL_APPLY_CONTRACT_MIN_CLI } from "./local-apply/contract.js";
import { RELAY_NAME_STABLE_MIN_CLI } from "./machine-identity.js";
import { RESOURCES_MIN_CLI } from "./runner-resources.js";
import { BOOTSTRAP_MIN_CLI, RUNNER_CONTROL_MIN_CLI, RUNNER_FEATURES, runnerFeatureGaps, runnerVersionView } from "./runner-features.js";

describe("what a runner version is too old for (#859)", () => {
	it("the machine in #859 (0.4.60) is behind on clone, force-attach and runner_update — and nothing older", () => {
		const gaps = runnerFeatureGaps("0.4.60")?.map((g) => g.feature) ?? [];
		expect(gaps).toEqual(expect.arrayContaining([expect.stringMatching(/^runner_update/), expect.stringMatching(/^coding_repo_add clone/), expect.stringMatching(/^force_runner_attach/)]));
		expect(gaps).not.toContain("fast-forward a stale checkout");
	});

	it("a current runner is behind on nothing; an unknown version is not judged", () => {
		expect(runnerFeatureGaps(LOCAL_APPLY_CONTRACT_MIN_CLI)).toEqual([]);
		// 0.4.71 reports load and memory, and is behind only on the rest of the machine (#924).
		expect(runnerFeatureGaps(RESOURCES_MIN_CLI)?.map((g) => g.feature)).toEqual(["disk, runner restarts, relay round trip and per-session usage in the resource history", "Codex local browser research (the browser tools approved for codex exec, #952)", "email-lead live-page preflight before application tailoring"]);
		expect(runnerFeatureGaps("")).toBeNull();
		expect(runnerVersionView(null)).toEqual({ runnerVersion: null, behind: null });
	});

	it("reports each gap with the version it needs", () => {
		expect(runnerVersionView("0.4.58").behind).toContain("fast-forward a stale checkout (needs 0.4.59)");
		expect(RUNNER_FEATURES.every((f) => /^\d+\.\d+\.\d+$/.test(f.minCli))).toBe(true);
	});

	it("a machine on 0.4.62 can be updated remotely but has no self-updating stub yet (#862)", () => {
		expect(runnerFeatureGaps(RUNNER_CONTROL_MIN_CLI)?.map((g) => g.feature)).toContain("self-updating pags up (never needs a manual install again)");
	});

	it("a machine on 0.4.63 is behind only on stable relay names (#922), the secret handoff (#918), the failed-turn output (#889), the supervisor restart (#860) and the engine check (#879)", () => {
		expect(runnerFeatureGaps(BOOTSTRAP_MIN_CLI)?.map((g) => g.feature)).toEqual([
			"disk, runner restarts, relay round trip and per-session usage in the resource history",
			"Codex local browser research (the browser tools approved for codex exec, #952)",
			"machine CPU load and memory in list_runner_nodes / coding_diagnostics",
			"relay sockets that keep their machine name when the hostname changes",
			"tmux_secure_put / tmux_secure_get (machine-to-machine secret files)",
			"the engine's own output in a failed run's detail",
			"engine check before launch (installed + signed in), required by apply-now",
			"runner_update restarts pags up itself, and service-managed runners",
			"email-lead live-page preflight before application tailoring",
		]);
	});

	it("a machine one release behind the engine check is told so, and a current one is not (#879)", () => {
		expect(runnerVersionView("0.4.66").behind).toEqual([
			"disk, runner restarts, relay round trip and per-session usage in the resource history (needs 0.4.76)",
			"Codex local browser research (the browser tools approved for codex exec, #952) (needs 0.4.74)",
			"machine CPU load and memory in list_runner_nodes / coding_diagnostics (needs 0.4.71)",
			"relay sockets that keep their machine name when the hostname changes (needs 0.4.70)",
			"tmux_secure_put / tmux_secure_get (machine-to-machine secret files) (needs 0.4.69)",
			"the engine's own output in a failed run's detail (needs 0.4.68)",
			"engine check before launch (installed + signed in), required by apply-now (needs 0.4.67)",
			"email-lead live-page preflight before application tailoring (needs 0.4.90)",
		]);
		expect(runnerFeatureGaps(ENGINE_CHECK_MIN_CLI)?.map((g) => g.feature)).toEqual([
			"disk, runner restarts, relay round trip and per-session usage in the resource history",
			"Codex local browser research (the browser tools approved for codex exec, #952)",
			"machine CPU load and memory in list_runner_nodes / coding_diagnostics",
			"relay sockets that keep their machine name when the hostname changes",
			"tmux_secure_put / tmux_secure_get (machine-to-machine secret files)",
			"the engine's own output in a failed run's detail",
			"email-lead live-page preflight before application tailoring",
		]);
	});

	it("a machine on 0.4.68 is behind only on stable relay names (#922) and the secret handoff (#918)", () => {
		expect(runnerVersionView("0.4.68").behind).toEqual([
			"disk, runner restarts, relay round trip and per-session usage in the resource history (needs 0.4.76)",
			"Codex local browser research (the browser tools approved for codex exec, #952) (needs 0.4.74)",
			"machine CPU load and memory in list_runner_nodes / coding_diagnostics (needs 0.4.71)",
			"relay sockets that keep their machine name when the hostname changes (needs 0.4.70)",
			"tmux_secure_put / tmux_secure_get (machine-to-machine secret files) (needs 0.4.69)",
			"email-lead live-page preflight before application tailoring (needs 0.4.90)",
		]);
	});

	it("a machine on 0.4.70 is behind only on resource telemetry (#924)", () => {
		expect(runnerFeatureGaps(RELAY_NAME_STABLE_MIN_CLI)?.map((g) => g.feature)).toEqual(["disk, runner restarts, relay round trip and per-session usage in the resource history", "Codex local browser research (the browser tools approved for codex exec, #952)", "machine CPU load and memory in list_runner_nodes / coding_diagnostics", "email-lead live-page preflight before application tailoring"]);
	});

	it("a machine on 0.4.69 is behind only on resource telemetry (#924) and stable relay names (#922)", () => {
		expect(runnerFeatureGaps(SECURE_HANDOFF_MIN_CLI)?.map((g) => g.feature)).toEqual(["disk, runner restarts, relay round trip and per-session usage in the resource history", "Codex local browser research (the browser tools approved for codex exec, #952)", "machine CPU load and memory in list_runner_nodes / coding_diagnostics", "relay sockets that keep their machine name when the hostname changes", "email-lead live-page preflight before application tailoring"]);
	});
});
