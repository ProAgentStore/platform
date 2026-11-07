import { describe, expect, it } from "vitest";
import { TRIGGER_ACTION_NAMES } from "./instance-tools/shared.js";

// #1581: `list_trigger_actions` reports the API's vocabulary; `create_instance_trigger`'s enum is
// a copy this worker cannot import at runtime. Pin the copy to the source.
describe("create_instance_trigger action enum", () => {
	it("matches the API's TRIGGER_ACTIONS, so no listed action is refused", async () => {
		const { TRIGGER_ACTIONS } = await import("../../api/src/lib/trigger-types.js");
		expect([...TRIGGER_ACTION_NAMES].sort()).toEqual([...TRIGGER_ACTIONS].sort());
	});
});
