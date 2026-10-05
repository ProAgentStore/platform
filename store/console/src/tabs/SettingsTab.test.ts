import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The card moved into settings/InstanceInfo.tsx at #911; the tab still has to mount it.
const TAB = readFileSync(join(__dirname, "SettingsTab.tsx"), "utf8");
const SRC = readFileSync(join(__dirname, "settings", "InstanceInfo.tsx"), "utf8");

describe("SettingsTab displays the instance ID for deep links (#909)", () => {
	it("mounts the InstanceInfo card that holds it", () => {
		expect(TAB).toContain('import InstanceInfo from "./settings/InstanceInfo"');
		expect(TAB).toContain("<InstanceInfo");
	});

	it("renders an Instance ID card with the instanceId", () => {
		expect(SRC).toContain('data-testid="instance-id-value"');
		expect(SRC).toContain("{instanceId}");
		expect(SRC).toContain("Instance ID");
	});

	it("provides a copy button for the instance ID", () => {
		expect(SRC).toContain('data-testid="instance-id-copy-button"');
		expect(SRC).toContain("copyInstanceId");
		expect(SRC).toContain("Copy ID");
	});

	it("includes documentation about using the instance ID for deep links", () => {
		expect(SRC).toContain("deep links");
		expect(SRC).toContain("secure-inputs");
	});
});
