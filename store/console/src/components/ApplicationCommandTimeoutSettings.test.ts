import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ draft: undefined as string | undefined }));
vi.mock("react", async (load) => ({ ...await load<typeof import("react")>(), useState: (value: string) => [harness.draft ?? value, vi.fn()] }));
import ApplicationCommandTimeoutSettings from "./ApplicationCommandTimeoutSettings";

function button(tree: ReactElement<{ children: unknown }>): ReactElement<{ disabled: boolean; onClick(): void }> {
	return (tree.props.children as ReactElement[]).find((child) => child?.type === "button") as ReturnType<typeof button>;
}

describe("per-instance browser command timeout control", () => {
	it.each(["1", "600", "3600"])("sends seconds exactly as entered: %s", (draft) => {
		harness.draft = draft;
		const onChange = vi.fn();
		const save = button(ApplicationCommandTimeoutSettings({ value: 900, busy: false, onChange }));
		expect(save.props.disabled).toBe(false); save.props.onClick();
		expect(onChange).toHaveBeenCalledWith({ browserCommandTimeoutSeconds: Number(draft) });
	});
	it.each(["", "0", "3601", "1.5", "invalid"])("disables malformed or incomplete values: %s", (draft) => {
		harness.draft = draft;
		expect(button(ApplicationCommandTimeoutSettings({ busy: false, onChange: vi.fn() })).props.disabled).toBe(true);
	});
	it("defaults to 600 seconds and disables unchanged or busy saves", () => {
		harness.draft = undefined;
		expect(button(ApplicationCommandTimeoutSettings({ busy: false, onChange: vi.fn() })).props.disabled).toBe(true);
		harness.draft = "900";
		expect(button(ApplicationCommandTimeoutSettings({ busy: true, onChange: vi.fn() })).props.disabled).toBe(true);
	});
});
