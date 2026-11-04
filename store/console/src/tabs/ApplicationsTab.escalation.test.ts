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
import { SubmissionPolicy } from "./ApplicationsTab";

const settings: ApplicationRunnerSettingsView["settings"] = {
	engine: "codex", authMode: "machine", browserProfile: "default", workspace: "~/jobs",
	maxMinutes: 20, maxPages: 30, maxActions: 300, signInEmail: null,
	escalationLevel: "conservative", sources: { profile: "saved-profile.txt" }, allowDomains: ["saved.test"],
	autoSubmit: { enabled: false, roles: ["saved role"], locations: [], exclude: [], minSalary: null, dailyCap: 0 },
};
const draft = { profile: "unsaved-profile.txt", answers: "unsaved-answers.txt", signInEmail: "draft@example.test", allowDomains: "unsaved.test", roles: "unsaved role", locations: "Melbourne", exclude: "contract", minSalary: "150000", dailyCap: "3" };

function control(node: unknown): ReactElement<{ onChange: (patch: { escalationLevel: "balanced" }) => void }> | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (Array.isArray(node)) return node.map(control).find(Boolean);
	const element = node as ReactElement<{ children?: unknown }>;
	if (element.type === ApplicationEscalationSettings) return element as ReturnType<typeof control>;
	return control(element.props?.children);
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
