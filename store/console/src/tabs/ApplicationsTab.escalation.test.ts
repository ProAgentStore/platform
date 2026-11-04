import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationRunnerSettingsView } from "../lib/types";
import ApplicationEscalationSettings from "../components/ApplicationEscalationSettings";

const harness = vi.hoisted(() => ({ states: [] as unknown[], setters: [] as ReturnType<typeof vi.fn>[], index: 0, api: vi.fn() }));
vi.mock("react", async (load) => ({
	...await load<typeof import("react")>(),
	useState: (initial: unknown) => {
		const i = harness.index++;
		harness.setters[i] ??= vi.fn();
		return [i < harness.states.length ? harness.states[i] : initial, harness.setters[i]];
	},
	useEffect: () => {},
	useCallback: (fn: unknown) => fn,
}));
vi.mock("@proagentstore/sdk/client", async (load) => ({ ...await load<typeof import("@proagentstore/sdk/client")>(), api: harness.api }));
import ApplicationToolAccessSettings, { type ToolAccessPatch } from "../components/ApplicationToolAccessSettings";
import { SubmissionPolicy } from "./ApplicationsTab";

const settings: ApplicationRunnerSettingsView["settings"] = {
	engine: "codex", authMode: "machine", browserProfile: "default", workspace: "~/jobs",
	maxMinutes: 20, maxPages: 30, maxActions: 300, signInEmail: null,
	escalationLevel: "conservative", toolAccess: "guarded", toolAccessAcceptance: null, sources: { profile: "saved-profile.txt" }, allowDomains: ["saved.test"],
	autoSubmit: { enabled: false, roles: ["saved role"], locations: [], exclude: [], minSalary: null, dailyCap: 0 },
};
const draft = { profile: "unsaved-profile.txt", answers: "unsaved-answers.txt", signInEmail: "draft@example.test", allowDomains: "unsaved.test", roles: "unsaved role", locations: "Melbourne", exclude: "contract", minSalary: "150000", dailyCap: "3" };

function control(node: unknown, target: unknown = ApplicationEscalationSettings): ReactElement<{ onChange: (patch: { escalationLevel: "balanced" }) => void }> | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) return node.map((child) => control(child, target)).find(Boolean);
	const element = node as ReactElement<{ children?: unknown }>;
	if (element.type === target) return element as ReturnType<typeof control>;
	return control(element.props?.children, target);
}

beforeEach(() => { harness.index = 0; harness.states = [settings, { ...draft }]; harness.setters = []; harness.api.mockReset(); });

describe("escalation-only save preserves other settings being edited", () => {
	it("uses the saved server policy without reloading or overwriting unsaved drafts", async () => {
		const saved = { ...settings, escalationLevel: "balanced" as const };
		harness.api.mockResolvedValue({ settings: saved });
		const onChanged = vi.fn();
		control(SubmissionPolicy({ runnerId: "runner", onChanged }))!.props.onChange({ escalationLevel: "balanced" });
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(harness.api).toHaveBeenCalledExactlyOnceWith("/v1/instances/runner/application-runner/settings", { method: "PUT", body: '{"escalationLevel":"balanced"}' });
		expect(harness.setters[0]).toHaveBeenCalledExactlyOnceWith(saved);
		expect(harness.setters[1]).not.toHaveBeenCalled();
		expect(harness.states[1]).toEqual(draft);
	});
	it("keeps both saved settings and drafts when the update fails", async () => {
		harness.api.mockRejectedValue(new Error("Update failed"));
		const onChanged = vi.fn();
		control(SubmissionPolicy({ runnerId: "runner", onChanged }))!.props.onChange({ escalationLevel: "balanced" });
		await vi.waitFor(() => expect(harness.setters[2]).toHaveBeenCalledWith("Update failed"));
		expect(harness.setters[0]).not.toHaveBeenCalled();
		expect(harness.setters[1]).not.toHaveBeenCalled();
		expect(onChanged).not.toHaveBeenCalled();
		expect(harness.setters[3]).toHaveBeenLastCalledWith(false);
	});
});


describe("full tool access save verifies acceptance without overwriting other drafts", () => {
	const acceptance = { revision: "full_playwright_v1" as const, acceptedAt: "2026-11-05T00:00:00Z", acceptedBy: "owner", instanceId: "runner" };
	function save(patch: ToolAccessPatch, onChanged: () => void) {
		const element = control(SubmissionPolicy({ runnerId: "runner", onChanged }), ApplicationToolAccessSettings) as unknown as ReactElement<{ onChange: (patch: ToolAccessPatch) => void }>;
		element.props.onChange(patch);
	}
	it("sends exact explicit acceptance, verifies saved receipt and keeps profile drafts", async () => {
		const saved = { ...settings, toolAccess: "full", toolAccessAcceptance: acceptance };
		harness.api.mockResolvedValue({ settings: saved });
		const onChanged = vi.fn();
		save({ toolAccess: "full", acknowledgeFullBrowserTools: "full_playwright_v1" }, onChanged);
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(harness.api).toHaveBeenCalledExactlyOnceWith("/v1/instances/runner/application-runner/settings", { method: "PUT", body: '{"toolAccess":"full","acknowledgeFullBrowserTools":"full_playwright_v1"}' });
		expect(harness.setters[0]).toHaveBeenCalledExactlyOnceWith(saved);
		expect(harness.setters[1]).not.toHaveBeenCalled();
		expect(harness.setters[8]).toHaveBeenCalledExactlyOnceWith(false);
	});
	it.each([null, { ...acceptance, instanceId: "other" }, { ...acceptance, revision: "old" }])("refuses to show success when the acceptance readback is invalid: %j", async (toolAccessAcceptance) => {
		harness.api.mockResolvedValue({ settings: { ...settings, toolAccess: "full", toolAccessAcceptance } });
		const onChanged = vi.fn();
		save({ toolAccess: "full", acknowledgeFullBrowserTools: "full_playwright_v1" }, onChanged);
		await vi.waitFor(() => expect(harness.setters[2]).toHaveBeenCalledWith(expect.stringContaining("server did not confirm")));
		expect(harness.setters[0]).not.toHaveBeenCalled();
		expect(harness.setters[1]).not.toHaveBeenCalled();
		expect(onChanged).not.toHaveBeenCalled();
	});
	it("disables with an exact patch and verifies the cleared acceptance", async () => {
		harness.api.mockResolvedValue({ settings });
		const onChanged = vi.fn();
		save({ toolAccess: "guarded" }, onChanged);
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(harness.api.mock.calls[0][1].body).toBe('{"toolAccess":"guarded"}');
		expect(harness.setters[1]).not.toHaveBeenCalled();
	});
});
