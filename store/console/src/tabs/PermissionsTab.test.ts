/**
 * #1060: an instance's Settings and Permissions are two tabs. Settings is what the agent IS (name, brain,
 * engine, runner, triggers, voice); Permissions is what it may REACH and DO (the permission-request card,
 * tool permissions, Gmail / Drive / WorkDrive). Both tabs are rendered for real; a permission push lands
 * on Permissions, and one delivered before the split still does.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instancePermissionsLink, instanceSettingsLink } from "../../../../workers/api/src/lib/console-links";
import { PERMISSIONS_CONTROL_ID } from "../lib/permissionRequestFocus";
import { legacyTabRedirect, parseInstanceSplat, resolveInstanceRoute } from "../lib/instanceRoute";
import { checkConsoleLink } from "../lib/routes";
import { SURFACES, visibleSurfaces } from "../lib/surfaces";
import PermissionsTab from "./PermissionsTab";
import SettingsTab from "./SettingsTab";

beforeEach(() => vi.stubGlobal("window", { location: { search: "" }, addEventListener: () => undefined, removeEventListener: () => undefined }));
afterEach(() => vi.unstubAllGlobals());

const PLAIN_AGENT = visibleSurfaces({ surfaces: [] }).map((s) => s.id);

describe("two tabs, both on every agent (#1060)", () => {
	it("Settings and Permissions are separate tabs, side by side, for any agent", () => {
		expect(PLAIN_AGENT).toEqual(expect.arrayContaining(["settings", "permissions"]));
		const ids = SURFACES.map((s) => s.id);
		expect(ids.indexOf("permissions")).toBe(ids.indexOf("settings") + 1);
		expect(SURFACES.find((s) => s.id === "permissions")).toMatchObject({ label: "Permissions", scroll: true });
	});

	it("navigation: each tab's route mounts that tab, not the other", () => {
		expect(resolveInstanceRoute("settings", PLAIN_AGENT).tab).toBe("settings");
		expect(resolveInstanceRoute("permissions", PLAIN_AGENT).tab).toBe("permissions");
	});
});

describe("each tab renders its own content", () => {
	const permissions = () => renderToStaticMarkup(createElement(PermissionsTab, { instanceId: "i1", instanceName: "Scout" }));
	const settings = () =>
		renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SettingsTab, { instanceId: "i1", instanceName: "Scout", isApply: false, onUnsubscribe: () => undefined })));

	it("Permissions holds Permissions & Connections — and none of Settings", () => {
		const html = permissions();
		expect(html).toContain('data-testid="permissions-and-connections"');
		expect(html).toContain("Permissions &amp; Connections");
		expect(html).not.toContain('data-testid="instance-id-value"');
		expect(html).not.toContain('data-testid="settings-brain-section"');
	});

	it("Settings keeps the instance, brain and runner — and no longer holds Permissions & Connections", () => {
		const html = settings();
		expect(html).toContain('data-testid="instance-id-value"');
		expect(html).toContain('data-testid="settings-brain-section"');
		expect(html).not.toContain('data-testid="permissions-and-connections"');
	});

	it("a permission push focuses a control that is on the Permissions tab", () => {
		// The push link carries focus=permissions; the page scrolls to and focuses this control's id.
		vi.stubGlobal("window", { location: { search: "?focus=permissions&permission_request=pr_1" }, addEventListener: () => undefined, removeEventListener: () => undefined });
		expect(permissions()).toContain(`id="${PERMISSIONS_CONTROL_ID}"`);
		expect(settings()).not.toContain(`id="${PERMISSIONS_CONTROL_ID}"`);
	});
});

describe("permission links land on the Permissions tab", () => {
	it("the link the API builds names the Permissions tab and passes the console's link check", () => {
		const link = instancePermissionsLink("i1", "pr_1");
		expect(link).toBe("/console/instances/i1/permissions?focus=permissions&permission_request=pr_1");
		expect(checkConsoleLink(link)).toMatchObject({ ok: true });
		expect(instanceSettingsLink("i1")).toBe("/console/instances/i1/settings");
	});

	it("a push delivered before the split (/settings?focus=permissions) is redirected, query kept", () => {
		const old = "/console/instances/i1/settings?focus=permissions&permission_request=pr_1";
		expect(checkConsoleLink(old)).toMatchObject({ ok: true });
		const [path, search] = old.split("?");
		expect(legacyTabRedirect(parseInstanceSplat(path.split("/instances/i1/")[1]).requestedTab, `?${search}`)).toBe("permissions");
	});

	it("an ordinary Settings link is not redirected", () => {
		expect(legacyTabRedirect("settings", "")).toBeNull();
		expect(legacyTabRedirect("settings", "?takeover=t1")).toBeNull();
		expect(legacyTabRedirect("knowledge", "?focus=permissions")).toBeNull();
	});
});
