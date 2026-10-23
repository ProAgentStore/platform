import { describe, expect, it } from "vitest";
import { type CalendarStatus, calendarStateLine } from "./calendarState";

const status = (over: Partial<CalendarStatus>): CalendarStatus => ({ access: "ok", account: "owner@gmail.com", accounts: 1, message: null, checked: true, reach: { grants: 1, instances: 1 }, ...over });

describe("calendarStateLine (#1313)", () => {
	it("says access works only when Google accepted the stored credential, and allows granting", () => {
		expect(calendarStateLine(status({}))).toEqual({ text: "Connected as owner@gmail.com — access works.", tone: "ok", canGrant: true });
	});
	it("names a revoked connection and blocks granting", () => {
		const s = calendarStateLine(status({ access: "revoked" }));
		expect(s).toMatchObject({ tone: "warn", canGrant: false });
		expect(s.text).toMatch(/revoked or expired.*Reconnect/);
	});
	it("tells an owner with no connection where to make one, and blocks granting", () => {
		expect(calendarStateLine(status({ access: "not_connected", account: null }))).toMatchObject({ tone: "warn", canGrant: false, text: expect.stringMatching(/not connected.*Preferences → Connections/) });
	});
	it("does not claim a connection before the check has answered", () => {
		expect(calendarStateLine(null)).toMatchObject({ tone: "muted", canGrant: false });
	});
	it("passes a failed check's own message through", () => {
		expect(calendarStateLine(status({ access: "error", message: "boom" })).text).toBe("boom");
	});
});
