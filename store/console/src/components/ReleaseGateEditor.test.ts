/**
 * #1347 — the gate editor and the readiness block render what the server said and nothing it did not.
 * Rendered markup, no browser (there is no DOM in this suite): the click sequences (save, cancel, clear,
 * a refused save keeping the saved gate) run in a real browser in e2e/release-gate.spec.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readiness } from "../lib/releaseGate";
import type { InstanceReleaseNotesResponse } from "../lib/types";
import ReleaseGateEditor from "./ReleaseGateEditor";
import ReleaseReadiness from "./ReleaseReadiness";

const CHESS = [
	{ path: ".github/workflows/ci.yml", role: "check" as const },
	{ path: ".github/workflows/e2e-full.yml", role: "check" as const },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy" as const, jobName: "deploy", stepName: "Upload to R2" },
];
const OLD = [{ path: ".github/workflows/ci.yml", role: "check" as const }, { path: ".github/workflows/deploy.yml", role: "production_deploy" as const }];
const send = async () => undefined;
const editor = (props: Partial<Parameters<typeof ReleaseGateEditor>[0]> = {}) => renderToStaticMarkup(createElement(ReleaseGateEditor, { saved: CHESS, gate: { state: "ready" }, send, ...props }));

describe("the saved gate, as read back", () => {
	it("shows every workflow and the deploy job and step, so a reload shows what is stored", () => {
		const html = editor();
		for (const p of [".github/workflows/ci.yml", ".github/workflows/e2e-full.yml", ".github/workflows/deploy.yml"]) expect(html).toContain(p);
		expect(html).toMatch(/job <code>deploy<\/code>/);
		expect(html).toMatch(/step <code>Upload to R2<\/code>/);
		expect(html).toContain("Verified production note");
		expect(html).toContain('data-gate-mode="verified"');
	});
	it("with no gate, says it is the immediate status note and offers to set one up, with nothing to clear", () => {
		const html = editor({ saved: undefined, gate: { state: "none" } });
		expect(html).toContain("Status note after a trunk-changing run");
		expect(html).toContain("No gate configured.");
		expect(html).toContain("Set up a gate");
		expect(html).not.toContain("Clear gate");
	});
	it("an old gate is not described as verified: it shows the server's message and says the deploy proof is missing", () => {
		const html = editor({ saved: OLD, gate: { state: "configuration_required", message: "Set jobName and stepName on the deploy workflow" } });
		expect(html).toContain('data-gate-mode="setup_needed"');
		expect(html).toContain("Set jobName and stepName on the deploy workflow");
		expect(html).toContain("no deploy job and step named yet");
		expect(html).toContain("Add the deploy job and step");
		expect(html).not.toContain("Verified production note</p>");
	});
});

describe("the editor", () => {
	it("has the deploy job and step fields on the deploy row only, each labelled for a screen reader", () => {
		const html = editor({ defaultEditing: true });
		expect(html.match(/aria-label="Deploy job name"/g)).toHaveLength(1);
		expect(html.match(/aria-label="Deploy step name"/g)).toHaveLength(1);
		expect(html).toContain('value="Upload to R2"');
		expect(html.match(/type="radio"/g)).toHaveLength(3);
		expect(html).toContain("Save gate");
		expect(html).toContain("Cancel");
	});
	it("shows no error before the owner has tried to save, then puts the message beside the deploy row", () => {
		const blank = [{ path: ".github/workflows/ci.yml", role: "check" as const }, { path: ".github/workflows/deploy.yml", role: "production_deploy" as const }];
		expect(editor({ saved: blank, gate: { state: "configuration_required" }, defaultEditing: true })).not.toContain('role="alert"');
		const html = editor({ saved: blank, gate: { state: "configuration_required" }, defaultEditing: true, defaultTried: true });
		expect(html).toContain('id="gate-row-1-error"');
		expect(html).toContain("Name the deploy job exactly as GitHub Actions shows it.");
		expect(html).toContain('aria-invalid="true"');
		expect(html).not.toContain('id="gate-row-0-error"');
	});
	it("Save is off until something changed", () => {
		expect(editor({ defaultEditing: true })).toMatch(/<button[^>]*disabled[^>]*>Save gate/);
	});
});

describe("the readiness block", () => {
	const v = (over: Partial<InstanceReleaseNotesResponse["effective"]> = {}, gate: InstanceReleaseNotesResponse["gate"] = { state: "ready" }): InstanceReleaseNotesResponse =>
		({ settings: {}, account: null, gate, effective: { enabled: true, enabledFrom: "platform", channelsFrom: "all", missing: [], channels: [{ provider: "slack", grantId: "g", channelId: "C1", name: "#release-notes", selected: true }], ...over } }) as InstanceReleaseNotesResponse;
	const runner = { node: "mac", connected: true, version: "0.4.179" };
	const html = (view: InstanceReleaseNotesResponse, r = runner, botMissing: string[] = []) => renderToStaticMarkup(createElement(ReleaseReadiness, { verdict: readiness({ view, botMissing, runner: r }) }));

	it("says ready only when nothing is in the way", () => {
		expect(html(v())).toContain("Ready to publish");
	});
	it("never says ready for any of the states the issue names, and names each one", () => {
		const cases: Array<[string, string]> = [
			[html(v({ channels: [] })), "No channel is granted"],
			[html(v({ channels: [{ provider: "slack", grantId: "g", channelId: "C1", name: "#a", selected: false }] })), "none is selected"],
			[html(v(), runner, ["#release-notes"]), "bot is not in #release-notes"],
			[html(v({}, { state: "none" })), "No gate is configured"],
			[html(v({}, { state: "configuration_required" })), "no deploy job and step"],
			[html(v(), { ...runner, version: "0.4.178" }), "0.4.178"],
			[html(v(), { node: "mac", connected: false, version: "0.4.179" }), "offline"],
		];
		for (const [out, text] of cases) {
			expect(out, text).toContain("Not ready to publish");
			expect(out, text).toContain(text);
			expect(out, text).not.toContain("Ready to publish");
		}
	});
});
