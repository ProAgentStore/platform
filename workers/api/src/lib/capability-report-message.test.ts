/** #1321 - "this machine has not reported" says WHY, instead of always telling the owner to update. */
import { describe, expect, it } from "vitest";
import { CAPABILITY_REPORT_MIN_CLI, capabilityNotReportedMessage } from "./capability-report-message.js";

const published = (latest: string) => ({ latest, published: { [latest]: Date.now() } });
const NOT_REPORTED = /has not reported its capabilities/;
const GENERIC = /Update the runner \(`pags update`\) and keep `pags up` running/;

describe("capabilityNotReportedMessage (#1321)", () => {
	it("reporting began in 0.4.177", () => {
		expect(CAPABILITY_REPORT_MIN_CLI).toBe("0.4.177");
	});

	it("the machine already runs the NEWEST release and that release lacks reporting: it says so, and that updating will not help (the 2026-10-23 state)", () => {
		const m = capabilityNotReportedMessage({ runnerVersion: "0.4.176", published: published("0.4.176") });
		expect(m).toContain("newest published runner (0.4.176)");
		expect(m).toContain("does not report capabilities");
		expect(m).toMatch(/Updating will not help/);
		expect(m).not.toMatch(GENERIC);
	});

	it("an older release than one that reports: update, naming both versions", () => {
		const m = capabilityNotReportedMessage({ runnerVersion: "0.4.170", published: published("0.4.180") });
		expect(m).toContain("0.4.170");
		expect(m).toContain("predates capability reporting");
		expect(m).toContain("0.4.180 is published");
		expect(m).toMatch(/pags update/);
	});

	it("a release that DOES report but has sent nothing: a different cause - check pags up, do not tell it to update", () => {
		const m = capabilityNotReportedMessage({ runnerVersion: "0.4.180", published: published("0.4.180") });
		expect(m).toContain("which reports at startup");
		expect(m).toMatch(/pags up/);
		expect(m).not.toMatch(/Updating will not help|predates/);
		expect(capabilityNotReportedMessage({ runnerVersion: "0.4.177", published: published("0.4.180") })).toContain("which reports at startup");
	});

	it("the registry cannot be asked: an old version still gets the update advice, without claiming what is published", () => {
		const m = capabilityNotReportedMessage({ runnerVersion: "0.4.170", published: null });
		expect(m).toContain("predates capability reporting");
		expect(m).not.toContain("is published");
	});

	it("no version known, or an unreadable one: the plain advice, never a guess", () => {
		expect(capabilityNotReportedMessage({ runnerVersion: null, published: published("0.4.180") })).toMatch(GENERIC);
		expect(capabilityNotReportedMessage({ runnerVersion: "  ", published: null })).toMatch(GENERIC);
		expect(capabilityNotReportedMessage({ runnerVersion: "dev-build", published: published("0.4.180") })).toMatch(GENERIC);
	});

	it("every variant still says the machine has not reported (the read-back's contract), whatever the cause", () => {
		for (const [runnerVersion, latest] of [["0.4.176", "0.4.176"], ["0.4.170", "0.4.180"], ["0.4.180", "0.4.180"], [null, "0.4.180"], ["0.4.170", null]] as const) {
			const m = capabilityNotReportedMessage({ runnerVersion, published: latest ? published(latest) : null });
			expect(m, `${runnerVersion}/${latest}`).toMatch(NOT_REPORTED);
		}
	});
});
