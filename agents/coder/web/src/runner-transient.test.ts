/**
 * A probe blip does not flip the runner to offline (#933).
 *
 * When the relay probe throws but the runner was seen recently, `/runtime/status` answers
 * `{runtime: {status: "online"}, transient: true}` with no `relay` (workers/api/src/routes/
 * instances.ts). Every reader took the missing `relay` as "offline", so one slow probe on a loaded
 * machine turned the dot grey for a poll cycle while the runner worked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTransientStatus, relayVerdict } from "./runner-online";

/** The exact transient answer the route sends. */
const BLIP = { runtime: { status: "online" }, transient: true };

describe("relayVerdict — transient blip vs a real reading", () => {
	it("a blip keeps an ONLINE runner online", () => {
		expect(relayVerdict(true, BLIP)).toBe(true);
	});

	it("a blip keeps an offline runner offline — it is not evidence either way", () => {
		expect(relayVerdict(false, BLIP)).toBe(false);
	});

	it("a blip before any reading stays unknown, never a fabricated offline", () => {
		expect(relayVerdict(null, BLIP)).toBeNull();
	});

	it("a GENUINE offline answer still reads offline, whatever came before", () => {
		expect(relayVerdict(true, { relay: { connected: false, runnerNode: "pink-laptop" } })).toBe(false);
	});

	it("a real online answer reads online", () => {
		expect(relayVerdict(false, { relay: { connected: true } })).toBe(true);
		expect(relayVerdict(null, { relay: { connected: true } })).toBe(true);
	});

	it("an answer that carries a relay reading is never treated as a blip", () => {
		expect(isTransientStatus({ transient: true, relay: { connected: false } })).toBe(false);
		expect(relayVerdict(true, { transient: true, relay: { connected: false } })).toBe(false);
		expect(isTransientStatus(BLIP)).toBe(true);
		expect(isTransientStatus(null)).toBe(false);
	});
});

describe("the Coding tab's relay check keeps its last reading through a blip", () => {
	const HOOK = readFileSync(join(__dirname, "use-runner-status.ts"), "utf8");

	it("folds each answer through relayVerdict, and keeps the attachment a blip does not carry", () => {
		const check = HOOK.slice(HOOK.indexOf("const checkRelay = useCallback"), HOOK.indexOf("useEffect(() => { void checkRelay(); }"));
		expect(check).toContain("setRelayOnline((prev) => relayVerdict(prev, d));");
		expect(check).toContain("if (!isTransientStatus(d)) setRelayAttachment(d.attachment ?? null);");
		expect(check).not.toContain("setRelayOnline(d.relay?.connected === true)");
	});
});
