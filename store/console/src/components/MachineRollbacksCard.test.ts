/** #1150 — the machine page's rollback card: from, to, why, and a Retry only when it can do something. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MachineRollback } from "../lib/machineDetail";
import MachineRollbacksCard from "./MachineRollbacksCard";

const r: MachineRollback = { from: "0.4.150", to: "0.4.148", reason: "it did not register within 5 minutes", at: "2026-10-25T01:00:00.000Z" };
const render = (over: Partial<Parameters<typeof MachineRollbacksCard>[0]> = {}) =>
	renderToStaticMarkup(createElement(MachineRollbacksCard, { rollbacks: [r], retryable: r, connected: true, busy: false, note: "", onRetry: () => undefined, ...over }));

describe("the rollback card", () => {
	it("renders nothing for a machine that never rolled back", () => {
		expect(render({ rollbacks: [], retryable: null })).toBe("");
	});
	it("shows from, to, why and when, with Retry for the latest release", () => {
		const html = render();
		expect(html).toContain("0.4.150");
		expect(html).toContain("0.4.148");
		expect(html).toContain("0.4.150 was rolled back to 0.4.148: it did not register within 5 minutes.");
		expect(html).toContain("2026-10-25 01:00 UTC");
		expect(html).toContain("Retry 0.4.150");
		expect(html).not.toContain(`disabled=""`);
	});
	it("disables Retry while asking and when the machine is offline, and says so", () => {
		expect(render({ busy: true })).toContain(`disabled=""`);
		const offline = render({ connected: false });
		expect(offline).toContain(`disabled=""`);
		expect(offline).toContain("The machine is offline.");
	});
	it("offers no Retry when a newer release than the rolled-back one is the latest", () => {
		const html = render({ retryable: null });
		expect(html).not.toContain("machine-rollback-retry");
		expect(html).toContain("A newer release than these installs as usual.");
	});
	it("shows the outcome note", () => {
		expect(render({ note: "Update started." })).toContain("Update started.");
	});
});
