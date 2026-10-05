/**
 * Where a notification row opens in the in-app list (#897), and that a signed-out tap keeps its
 * destination through sign-in.
 */
import { describe, expect, it } from "vitest";
import { withoutSessionParam } from "./auth";
import { notificationClick } from "./deepLink";
import { checkConsoleLink } from "./routes";

describe("notificationClick — the in-app list opens the row's subject", () => {
	it("follows the row's own deep link, under either basename", () => {
		expect(notificationClick({ url: "/console/instances/i1/coding/s1", instance_id: "i1" })).toEqual({ route: "/instances/i1/coding/s1" });
		expect(notificationClick({ url: "/console/instances/i1/coding?builds=r1" })).toEqual({ route: "/instances/i1/coding?builds=r1" });
	});

	it("opens a pre-#338 GitHub url where it lives", () => {
		expect(notificationClick({ url: "https://github.com/o/r/actions/runs/1" })).toEqual({ external: "https://github.com/o/r/actions/runs/1" });
	});

	it("falls back to the instance a link-less row is about — that click used to do nothing", () => {
		const click = notificationClick({ url: null, instance_id: "i1" });
		expect(click).toEqual({ route: "/instances/i1" });
		expect(checkConsoleLink(`/console${(click as { route: string }).route}`).ok).toBe(true);
	});

	it("then to the agent of an old row, and to nothing only when the row names nothing at all", () => {
		expect(notificationClick({ agent_id: "a1" })).toEqual({ route: "/agents/a1" });
		expect(notificationClick({})).toBeNull();
	});
});

describe("withoutSessionParam — sign-in continues to the full target", () => {
	it("keeps the deploy link's ?builds= and any hash, dropping only the session token", () => {
		expect(withoutSessionParam("https://proagentstore.online/console/instances/i1/coding?builds=r1&session=JWT")).toBe("/console/instances/i1/coding?builds=r1");
		expect(withoutSessionParam("https://console.proagentstore.online/instances/i1/tasks/t1?session=JWT&ask=1#input")).toBe("/instances/i1/tasks/t1?ask=1#input");
	});

	it("leaves a path with no other query bare", () => {
		expect(withoutSessionParam("https://proagentstore.online/console/instances/i1?session=JWT")).toBe("/console/instances/i1");
	});
});
