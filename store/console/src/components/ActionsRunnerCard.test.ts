import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionsRunnerStatusView } from "./ActionsRunnerCard";
import { actionsScope, canRequestActionsRecovery, type ActionsRunnerItem, type ActionsRunnerStatus } from "../lib/actionsRunnerStatus";

const managed: ActionsRunnerItem = {
	dir: "/runner/org", managed: true, name: "pags-tiny", url: "https://github.com/example-org",
	serviceMode: "macos_system", serviceState: "running", localHealth: "current", acRecoveryEnabled: true,
	supervisor: { health: "ready", updatedAt: Date.now(), activeJob: false, lastAcReturnAt: 1000, lastReadyAt: 2000, lastRecovery: { id: "rec-1", state: "ready", requestedAt: 1500 } },
	ci: { registered: true, online: true, busy: false, routable: true, labels: ["pags"], summary: "online" },
};

function markup(item: ActionsRunnerItem): string {
	const status: ActionsRunnerStatus = { node: "tiny", machineHealth: "current", installed: [item] };
	return renderToStaticMarkup(createElement(ActionsRunnerStatusView, { status, busy: false, note: "", onRefresh: () => undefined, onRecover: () => undefined }));
}

describe("Actions runner console status (#1367)", () => {
	it("shows local and GitHub facts separately, with AC policy and durable recovery outcome", () => {
		const html = markup(managed);
		expect(html).toContain("macos_system · running");
		expect(markup({ ...managed, serviceState: undefined })).toContain("macos_system</dd>");
		expect(html).toContain("ready");
		expect(html).toContain("online · idle · routable");
		expect(html).toContain("AC recovery");
		expect(html).toContain("rec-1");
		expect(html).toContain("Request recovery");
	});

	it("withholds recovery from a hand install or stale local sample", () => {
		expect(canRequestActionsRecovery({ ...managed, managed: false })).toBe(false);
		expect(canRequestActionsRecovery({ ...managed, localHealth: "stale" })).toBe(false);
		expect(markup({ ...managed, managed: false })).not.toContain("Request recovery");
		expect(markup({ ...managed, localHealth: "stale" })).toContain("stale sample");
		expect(markup({ ...managed, localHealth: "stale" })).not.toContain("Request recovery");
	});

	it("names active-job deferral and does not take a path from the browser", () => {
		expect(markup({ ...managed, supervisor: { ...managed.supervisor!, activeJob: true } })).toContain("Queue recovery after job");
		expect(actionsScope("https://github.com/example-org/a-repo")).toEqual({ repo: "example-org/a-repo" });
		expect(actionsScope("https://evil.example/example-org")).toBeNull();
		expect(actionsScope("https://github.com/example-org/a-repo/../../other")).toBeNull();
	});

	it("states unknown when the machine cannot answer", () => {
		const html = renderToStaticMarkup(createElement(ActionsRunnerStatusView, { status: { node: null, machineHealth: "unknown", machineNote: "relay timed out", installed: [] }, busy: false, note: "", onRefresh: () => undefined, onRecover: () => undefined }));
		expect(html).toContain("Machine status unknown");
		expect(html).toContain("relay timed out");
		expect(html).not.toContain("Request recovery");
	});

	it("does not describe an unregistered runner as merely offline", () => {
		const html = markup({ ...managed, ci: { ...managed.ci!, registered: false, online: false, routable: false } });
		expect(html).toContain("not registered");
		expect(html).not.toContain("offline · idle");
	});
});
