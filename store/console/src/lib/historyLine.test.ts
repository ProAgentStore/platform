import { describe, expect, it } from "vitest";
import { deliveriesLine, historyLineView, launchLine, loopRunsLine, takeoversLine } from "./historyLine";

describe("a Settings one-liner never asserts a state before it loaded (#1590)", () => {
	it("reads Checking… while loading, with nothing to open", () => {
		expect(historyLineView({ status: "loading" })).toEqual({ text: "Checking…", tone: "muted", link: false });
	});
	it("reads Couldn't check with the link on failure", () => {
		expect(historyLineView({ status: "failed" })).toEqual({ text: "Couldn't check", tone: "muted", link: true });
	});
});

describe("what each card says once loaded", () => {
	it("loop runs: N waiting for you in warning tone, else No runs waiting", () => {
		expect(historyLineView(loopRunsLine(2))).toEqual({ text: "2 waiting for you", tone: "warn", link: true });
		expect(historyLineView(loopRunsLine(0))).toEqual({ text: "No runs waiting", tone: "muted", link: true });
	});
	it("takeovers: a line only while one is live", () => {
		expect(historyLineView(takeoversLine(1))).toEqual({ text: "1 waiting for you", tone: "warn", link: true });
		expect(historyLineView(takeoversLine(0))).toBeNull();
	});
	it("deliveries: N undelivered, otherwise no line", () => {
		expect(historyLineView(deliveriesLine(3))).toMatchObject({ text: "3 undelivered", tone: "bad" });
		expect(historyLineView(deliveriesLine(0))).toBeNull();
	});
	it("last launch: a line only when it differs", () => {
		expect(historyLineView(launchLine(true))?.text).toBe("Differs from last launch");
		expect(historyLineView(launchLine(false))).toBeNull();
	});
});
