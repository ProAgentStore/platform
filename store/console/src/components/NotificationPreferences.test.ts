/**
 * #1283 — the switches render from the shared store's values (never a private copy), stay disabled until the stored settings are
 * known, and surface a refused save. Rendered markup, no browser: the behavioural sequences are in lib/notificationsStore.test.ts.
 * There is no DOM in this suite, so the clicks themselves (a switch carrying the rules, a rule carrying the mutes) are driven in a
 * real browser by e2e/notification-controls.spec.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotificationTypeSpec } from "../lib/types";
import NotificationPreferences from "./NotificationPreferences";

const TYPES: NotificationTypeSpec[] = [
	{ id: "deploy", label: "Deployments", description: "Deploy progress.", alerts: false },
	{ id: "apply", label: "Job applications", description: "Apply progress.", alerts: true },
];

function render(over: Partial<Parameters<typeof NotificationPreferences>[0]> = {}) {
	return renderToStaticMarkup(
		createElement(NotificationPreferences, { types: TYPES, muted: [], instances: [], onEdit: async () => true, ready: true, storeError: "", attentionEvents: [], pushOff: [], onPushOffSaved: () => undefined, ...over }),
	);
}

/** The attributes React wrote on the checkbox that carries this accessible name (they precede `aria-label` in the markup). */
function attrsOf(html: string, label: string): string {
	const at = html.indexOf(`aria-label="Notify me about ${label}"`);
	expect(at, label).toBeGreaterThan(-1);
	return html.slice(Math.max(0, at - 160), at + 80);
}

describe("the notification switches", () => {
	it("show the shared store's mutes: a muted type is unchecked, the rest are checked", () => {
		const html = render({ muted: ["deploy"] });
		expect(attrsOf(html, "Deployments")).not.toContain('checked=""');
		expect(attrsOf(html, "Job applications")).toContain('checked=""');
	});

	it("are disabled until the stored settings have loaded, so a write cannot overwrite them with defaults", () => {
		expect(attrsOf(render({ ready: false }), "Deployments")).toContain('disabled=""');
		expect(attrsOf(render({ ready: true }), "Deployments")).not.toContain('disabled=""');
	});

	it("announce a refused save, or a failed first read, as an alert", () => {
		const html = render({ storeError: "The server refused that." });
		expect(html).toContain('role="alert"');
		expect(html).toContain("The server refused that.");
		expect(render()).not.toContain('role="alert"');
	});
});
