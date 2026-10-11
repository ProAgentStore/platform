import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ApplicationHandoffLive, { mobileTakeoverKey, mobileTakeoverText } from "./ApplicationHandoffLive";

/** A synthetic phone viewport renders the actual owner handoff, not a source-text assertion. */
function renderPhone() {
	return renderToStaticMarkup(createElement(ApplicationHandoffLive, {
		instanceId: "instance-1", runId: "run-1", handoffId: "handoff-1", reconciliation: true,
		onClose: () => undefined, onChanged: () => undefined,
	}));
}

describe("ApplicationHandoffLive mobile reconciliation control", () => {
	it("renders a keyboard-capable, responsive native entry control for a phone-only owner", () => {
		const html = renderPhone();
		expect(html).toContain('data-testid="application-handoff-mobile-entry"');
		expect(html).toContain('data-testid="application-handoff-mobile-text-entry"');
		expect(html).toMatch(/<input[^>]*type="text"[^>]*inputMode="text"|<input[^>]*inputmode="text"[^>]*type="text"/);
		expect(html).toMatch(/enterKeyHint="next"|enterkeyhint="next"/);
		expect(html).toContain("Delete");
		expect(html).toContain("Continue");
	});

	it("uses the same keyboard-capable control for the existing live login handoff", () => {
		const html = renderToStaticMarkup(createElement(ApplicationHandoffLive, {
			instanceId: "instance-1", runId: "run-1", handoffId: "handoff-1", reconciliation: false,
			onClose: () => undefined, onChanged: () => undefined,
		}));
		expect(html).toContain('data-testid="application-handoff-mobile-text-entry"');
	});

	it("forwards only ephemeral text and two keyboard actions through the secure takeover vocabulary", () => {
		expect(mobileTakeoverText("123456")).toEqual({ type: "text", text: "123456" });
		expect(mobileTakeoverText("")).toBeNull();
		expect(mobileTakeoverKey("Enter")).toEqual({ type: "key", key: "Enter", code: "Enter" });
		expect(mobileTakeoverKey("Backspace")).toEqual({ type: "key", key: "Backspace", code: "Backspace" });
	});
});
