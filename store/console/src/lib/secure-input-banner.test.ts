/**
 * A secure input waiting on the owner is visible from every instance tab and on the instance card (#934).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexPendingInputs } from "../hooks/usePendingSecureInputs";
import { ownerWaiting, secureInputBannerText } from "./secureInput";
import type { SecureInputView } from "./types";

const req = (over: Partial<SecureInputView>): SecureInputView => ({
	id: "r",
	status: "pending",
	label: "OTP",
	destinationScope: "tmux",
	oneShot: true,
	expiresAt: "2026-10-07T00:00:00Z",
	createdAt: "2026-10-06T09:00:00Z",
	...over,
});

describe("ownerWaiting — what the banner counts", () => {
	it("keeps only requests waiting on the OWNER, oldest first", () => {
		const list = [
			req({ id: "new", createdAt: "2026-10-06T09:30:00Z" }),
			req({ id: "deposit", status: "ready", sourceNode: "Macmini" }),
			req({ id: "deposit-pending-shape", status: "pending", sourceNode: "Macmini" }),
			req({ id: "entered", status: "ready" }),
			req({ id: "used", status: "consumed" }),
			req({ id: "gone", status: "expired" }),
			req({ id: "old", createdAt: "2026-10-06T08:00:00Z" }),
		];
		expect(ownerWaiting(list).map((r) => r.id)).toEqual(["old", "new"]);
	});
});

describe("secureInputBannerText", () => {
	it("names the one value, or how many and the first", () => {
		expect(secureInputBannerText([{ label: "Firebase auth code" }])).toBe("This agent is waiting for you to enter a value: “Firebase auth code”.");
		expect(secureInputBannerText([{ label: "a" }, { label: "b" }])).toBe("This agent is waiting for you to enter 2 values, starting with “a”.");
		expect(secureInputBannerText([])).toBe("");
	});
});

describe("indexPendingInputs — the card's account-wide answer", () => {
	it("indexes by instance, and an empty or missing answer is an empty map", () => {
		const m = indexPendingInputs({ instances: [{ instanceId: "i1", pending: 2, requestId: "r1", label: "OTP" }] });
		expect(m.get("i1")).toEqual({ instanceId: "i1", pending: 2, requestId: "r1", label: "OTP" });
		expect(indexPendingInputs(null).size).toBe(0);
	});
});

describe("wiring (#934)", () => {
	const PAGE = readFileSync(join(__dirname, "..", "pages", "InstanceDetail.tsx"), "utf8");
	const DASH = readFileSync(join(__dirname, "..", "pages", "Dashboard.tsx"), "utf8");
	const BANNER = readFileSync(join(__dirname, "..", "components", "SecureInputBanner.tsx"), "utf8");

	it("the instance page shows the banner on every tab but chat, where the full list already is", () => {
		expect(PAGE).toContain('{id && tab !== "chat" && <SecureInputBanner instanceId={id} />}');
	});

	it("the banner links straight to the oldest request's entry page", () => {
		expect(BANNER).toContain("ownerWaiting(res.requests ?? [])");
		expect(BANNER).toContain("encodeURIComponent(first.id)");
		expect(BANNER).toContain("/secure-inputs/");
	});

	it("the instance card says how many values wait on the owner", () => {
		expect(DASH).toContain('usePendingSecureInputs(tab === "instances")');
		expect(DASH).toContain('data-testid="instance-secure-input-waiting"');
	});
});
