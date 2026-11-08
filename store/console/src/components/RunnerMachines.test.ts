import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import RunnerMachines from "./RunnerMachines";
import { type Machine, runnerCardView } from "../lib/runnerPanel";

const INST = "inst-1";
const fleet: Machine[] = ["a", "b", "c", "d", "e"].map((node) => ({
	node,
	machineId: node === "e" ? null : `id-${node}`,
	connected: true,
	resources: { warnings: [`Crash loop on ${node}: restarted 9 times`] } as unknown as Machine["resources"],
	runnerBehind: ["x"],
}));

function render(machines: Machine[], pin: string): string {
	const { pinned, others } = runnerCardView(machines, pin, INST, []);
	return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RunnerMachines, { pinned, others, onPick: () => {} })));
}

describe("RunnerMachines (#1594)", () => {
	it("shows one machine in detail and one count line; no other machine's warnings or CLI line", () => {
		const html = render(fleet, "b");
		expect(html).toContain("4 other machines");
		expect(html).toContain('href="/terminals"');
		expect(html).toContain("Manage machines");
		expect(html).toContain("Crash loop on b");
		for (const n of ["a", "c", "d", "e"]) expect(html).not.toContain(`Crash loop on ${n}`);
		expect(html.match(/CLI out of date/g)).toHaveLength(1);
		expect(html.match(/data-testid="runner-pinned-machine"/g)).toHaveLength(1);
	});

	it("links the pinned machine to its page when it has a machineId, and is plain text otherwise", () => {
		expect(render(fleet, "b")).toContain('href="/terminals/machines/id-b"');
		const plain = render(fleet, "e");
		expect(plain).not.toContain("runner-machine-link");
		expect(plain).toContain(">e<");
	});

	it("says '1 other machine' for one", () => {
		expect(render(fleet.slice(0, 2), "a")).toContain("1 other machine ·");
	});

	it("has no count line or Change machine when the pinned machine is the only one", () => {
		const html = render(fleet.slice(0, 1), "a");
		expect(html).not.toContain("other machine");
		expect(html).not.toContain("Change machine");
	});

	it("starts with the choices closed, and the disclosure says so", () => {
		const html = render(fleet, "b");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("runner-machine-choice");
	});

	it("unpinned: the compact list is shown directly, without alerts or health", () => {
		const html = render(fleet, "");
		expect(html.match(/data-testid="runner-machine-choice"/g)).toHaveLength(5);
		expect(html).not.toContain("Crash loop");
		expect(html).not.toContain("CLI out of date");
	});
});
