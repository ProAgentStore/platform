/**
 * The busy refusal's link resolves on both console hosts, and the Assistant tab shows it (#931).
 *
 * The link is an in-router path, so the basename — `/console` on proagentstore.online, `/` on
 * console.proagentstore.online (App.tsx `consoleBasename`) — is the router's job. Rendered here under
 * each basename to prove the anchor lands on the run's session page either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BusyHoldNotice, busyHoldFrom } from "@proagentstore/coder-web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

const hold = busyHoldFrom(
	Object.assign(new Error("busy"), {
		body: { reason: "busy", activeRun: { runId: "run-1", objective: "Fix issue #48", startedAt: Date.now() - 60_000, requestId: null, sessionId: "csess_abc" }, inFlightStarts: [] },
	}),
)!;

function render(basename: string, h = hold) {
	return renderToStaticMarkup(
		createElement(MemoryRouter, { basename, initialEntries: [`${basename === "/" ? "" : basename}/instances/inst-1`] }, createElement(BusyHoldNotice, { instanceId: "inst-1", hold: h, onDismiss: () => {} })),
	);
}

describe("BusyHoldNotice (#931)", () => {
	it("links to the blocking run's session on proagentstore.online/console", () => {
		const html = render("/console");
		expect(html).toContain('href="/console/instances/inst-1/coding/csess_abc"');
		expect(html).toContain('href="/console/instances/inst-1/settings"');
		expect(html).toContain("Open the running loop");
		expect(html).toContain('data-testid="busy-hold-stop"');
	});

	it("links to the same pages on console.proagentstore.online, where the app is mounted at /", () => {
		const html = render("/");
		expect(html).toContain('href="/instances/inst-1/coding/csess_abc"');
		expect(html).toContain('href="/instances/inst-1/settings"');
	});

	it("offers no run link when the run has no session — Stop and the runs list remain", () => {
		const html = render("/console", { ...hold, run: { ...hold.run!, sessionId: null } });
		expect(html).not.toContain("Open the running loop");
		expect(html).toContain('data-testid="busy-hold-stop"'); // the run can still be stopped
		expect(html).toContain('href="/console/instances/inst-1/settings"');
	});

	it("offers no Stop for a start that is still being set up — there is no run yet", () => {
		const html = render("/console", { run: null, pendingStart: { objective: "Ship it", ageMs: 1000 } });
		expect(html).not.toContain('data-testid="busy-hold-stop"');
		expect(html).toContain("still being set up");
	});

	it("never repeats the agent-facing tool name", () => {
		expect(render("/console")).not.toContain("stop_work");
	});
});

describe("the Assistant tab shows the hold instead of the bare refusal (#931)", () => {
	const PAGE = readFileSync(join(__dirname, "InstanceDetail.tsx"), "utf8");

	it("routes a busy refusal to the notice and keeps every other refusal's message", () => {
		expect(PAGE).toMatch(/const hold = busyHoldFrom\(e\);\s+if \(hold\) setBusyHold\(hold\);\s+else emitSystemChat\(loopStartFailureNotice\(e\)\);/);
	});

	it("renders the notice and clears it when a new start goes through", () => {
		expect(PAGE).toContain("<BusyHoldNotice instanceId={id} hold={busyHold} onDismiss={() => setBusyHold(null)} onQueue={() => void startLoop(true)} />");
		expect(PAGE).toMatch(/setLoopBadge\(null\);\s+setBusyHold\(null\);/);
	});
});
