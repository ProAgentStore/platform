import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApplicationToolAccessSettings from "./ApplicationToolAccessSettings";
import FullBrowserRunNotice from "./FullBrowserRunNotice";
import Button from "./Button";

const disclosure = { revision: "full_playwright_v1" as const, title: "Full browser access", risks: ["Unsafe code is not a sandbox."] };
const base = { settings: { toolAccess: "guarded" as const, toolAccessAcceptance: null }, disclosure, busy: false, acknowledged: false, onAcknowledge: vi.fn(), onChange: vi.fn() };
function find(node: unknown, type: unknown): ReactElement<{ disabled?: boolean; checked?: boolean; onClick: () => void; children?: unknown }> | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean);
	const element = node as ReactElement<{ children?: unknown }>;
	return element.type === type ? element as ReturnType<typeof find> : find(element.props?.children, type);
}

describe("full browser tool risk acceptance", () => {
	it.each([{ acknowledged: false }, { acknowledged: true, busy: true }, { acknowledged: true, disclosure: undefined }])("does not enable without current disclosure, acknowledgement and an idle save: %j", (patch) => {
		const onChange = vi.fn();
		const tree = ApplicationToolAccessSettings({ ...base, ...patch, onChange });
		const button = find(tree, Button)!;
		expect(button.props.disabled).toBe(true);
		button.props.onClick();
		expect(onChange).not.toHaveBeenCalled();
	});
	it("starts unchecked and renders the server's risks beside the specific acknowledgement", () => {
		const tree = ApplicationToolAccessSettings(base);
		expect(find(tree, "input")!.props.checked).toBe(false);
		const html = renderToStaticMarkup(createElement(ApplicationToolAccessSettings, base));
		expect(html).toContain(disclosure.risks[0]);
		expect(html).toContain("including unintended real actions");
		expect(html).toContain("invalidates queued full-tool runs");
	});
	it("emits only full access and the current acknowledgement after the explicit choice", () => {
		const onChange = vi.fn();
		const tree = ApplicationToolAccessSettings({ ...base, acknowledged: true, onChange });
		find(tree, Button)!.props.onClick();
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ toolAccess: "full", acknowledgeFullBrowserTools: "full_playwright_v1" });
	});
	it("displays the recorded acceptance and lets the owner disable without another acceptance", () => {
		const onChange = vi.fn();
		const props = { ...base, settings: { toolAccess: "full" as const, toolAccessAcceptance: { revision: "full_playwright_v1" as const, acceptedAt: "2026-11-05T00:00:00Z", acceptedBy: "owner", instanceId: "runner" } }, onChange };
		find(ApplicationToolAccessSettings(props), Button)!.props.onClick();
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ toolAccess: "guarded" });
		expect(renderToStaticMarkup(createElement(ApplicationToolAccessSettings, props))).toContain("Acceptance recorded 2026-11-05T00:00:00Z");
	});
});

describe("full run evidence warning", () => {
	it("uses frozen full mode and never equates a missing observed submission with no submission", () => {
		const html = renderToStaticMarkup(createElement(FullBrowserRunNotice, { toolAccess: "full", submissionVerification: "unverified", submitAttempted: false }));
		expect(html).toContain("No supervised submission attempt was recorded; this does not prove that no submission occurred.");
		expect(html).toContain("Submission remains unverified.");
	});
	it("renders no full-mode warning for guarded or historical unspecified policy", () => {
		for (const toolAccess of ["guarded", undefined] as const) expect(renderToStaticMarkup(createElement(FullBrowserRunNotice, { toolAccess, submitAttempted: false }))).toBe("");
	});
});
