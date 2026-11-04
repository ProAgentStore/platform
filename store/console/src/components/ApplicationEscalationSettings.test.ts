import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApplicationEscalationSettings from "./ApplicationEscalationSettings";

const levels = ["conservative", "balanced", "autonomous"] as const;
const render = (value?: (typeof levels)[number], busy = false) => renderToStaticMarkup(createElement(ApplicationEscalationSettings, { value, busy, onChange: () => {} }));

describe("Application Runner escalation settings", () => {
	it("defaults older responses to conservative and explains the remaining boundaries", () => {
		const html = render();
		expect(html).toContain('<option value="conservative" selected="">');
		for (const copy of ["The model assesses", "Unknown personal facts remain unresolved", "Submission permission is configured separately", "new runs", "Stop, credential and website restrictions still apply"]) expect(html).toContain(copy);
	});
	it.each(levels)("displays the saved %s level", (value) => {
		expect(render(value)).toContain(`<option value="${value}" selected="">`);
	});
	it.each(levels)("changing to %s emits only the escalation field, never submission authorization", (value) => {
		const onChange = vi.fn();
		const tree = ApplicationEscalationSettings({ value: "conservative", busy: false, onChange });
		const label = tree.props.children[0];
		const select = label.props.children[1] as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;
		select.props.onChange({ target: { value } });
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ escalationLevel: value });
		expect(JSON.parse(JSON.stringify(onChange.mock.calls[0][0]))).toEqual({ escalationLevel: value });
	});
	it("disables changes while the setting is being saved", () => {
		expect(render("balanced", true)).toContain('disabled=""');
		expect(render("balanced")).not.toContain('disabled=""');
	});
});
