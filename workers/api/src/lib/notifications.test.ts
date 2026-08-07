import { describe, expect, it } from "vitest";
import {
	DUPLICATE_WINDOW_MINUTES,
	isKnownNotificationType,
	NOTIFICATION_TYPES,
	notificationDedupeKey,
	pushAllowedByPreference,
	sanitizeNotificationPreferences,
} from "./notifications.js";

describe("notificationDedupeKey", () => {
	// The reason this is not a title compare, direction 1: one deploy, several titles.
	// `ProAgentStore/platform` runs several workflows per push and the run number is
	// PER-WORKFLOW, so the same commit's deploy arrives as "#412" and "#88" (#359).
	it("is the same for one event wearing different prose", () => {
		const a = notificationDedupeKey("deploy", "deploy:repo_1:abc1234", "✅ Deployed #412", "platform is live.");
		const b = notificationDedupeKey("deploy", "deploy:repo_1:abc1234", "✅ Deployed #88", "api Worker is live.");
		expect(a).toBe(b);
	});

	// Direction 2: different events, identical prose. Two agents stuck on the same site produce
	// byte-identical titles, and collapsing them would drop a run genuinely waiting on a human.
	it("differs for different events wearing identical prose", () => {
		const a = notificationDedupeKey("apply", "apply-handoff:task_1:challenge:0", "🔐 Verification needed", "same");
		const b = notificationDedupeKey("apply", "apply-handoff:task_2:challenge:0", "🔐 Verification needed", "same");
		expect(a).not.toBe(b);
	});

	it("falls back to title+body for a caller that declares no event", () => {
		const a = notificationDedupeKey("apply", undefined, "✅ Résumé parsed", "We filled 3 fields.");
		const b = notificationDedupeKey("apply", undefined, "✅ Résumé parsed", "We filled 3 fields.");
		const c = notificationDedupeKey("apply", undefined, "✅ Résumé parsed", "We filled 4 fields.");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	// Same event string under two types is two events — a shared id (an instance, a session)
	// must not make a deploy notification suppress a handoff.
	it("scopes the key by type", () => {
		expect(notificationDedupeKey("coding", "x", "t", "b")).not.toBe(notificationDedupeKey("deploy", "x", "t", "b"));
	});

	it("is bounded regardless of what a caller passes", () => {
		const key = notificationDedupeKey("deploy", "x".repeat(5000), "t".repeat(5000), "b".repeat(5000));
		expect(key.length).toBeLessThan(64);
	});

	it("bounds the window to minutes — it is a floor under a malfunction, not a policy", () => {
		expect(DUPLICATE_WINDOW_MINUTES).toBeGreaterThan(0);
		expect(DUPLICATE_WINDOW_MINUTES).toBeLessThanOrEqual(30);
	});
});

describe("pushAllowedByPreference", () => {
	// THE rule. A mute that can hide an actionable notification is how someone misses a run
	// blocked waiting for them — silent, open-ended, and indistinguishable from a slow agent.
	it("never mutes an alert, whatever the preference says", () => {
		const prefs = { muted: NOTIFICATION_TYPES.map((t) => t.id) };
		for (const t of NOTIFICATION_TYPES) {
			expect(pushAllowedByPreference(prefs, t.id, "alert")).toBe(true);
		}
	});

	it("mutes updates of a muted type, and only that type", () => {
		const prefs = { muted: ["deploy"] };
		expect(pushAllowedByPreference(prefs, "deploy", "update")).toBe(false);
		expect(pushAllowedByPreference(prefs, "coding", "update")).toBe(true);
	});

	it("allows everything when nothing is configured", () => {
		expect(pushAllowedByPreference(undefined, "deploy", "update")).toBe(true);
		expect(pushAllowedByPreference({ muted: [] }, "deploy", "update")).toBe(true);
	});
});

describe("sanitizeNotificationPreferences", () => {
	it("drops unknown and duplicate type ids", () => {
		expect(sanitizeNotificationPreferences({ muted: ["deploy", "deploy", "nope", 7] })).toEqual({ muted: ["deploy"] });
	});

	it("returns undefined for junk, never a broken shape", () => {
		for (const junk of [null, undefined, "deploy", 7, ["deploy"]]) {
			expect(sanitizeNotificationPreferences(junk)).toBeUndefined();
		}
		expect(sanitizeNotificationPreferences({})).toEqual({ muted: [] });
	});
});

describe("NOTIFICATION_TYPES", () => {
	// The console renders its controls from this table, so a type `notifyUser` is called with
	// and that is missing here has no control at all — the gap #360 reported.
	it("covers every type notifyUser is called with", () => {
		for (const id of ["apply", "coding", "deploy", "loop", "trigger", "subscribe"]) {
			expect(isKnownNotificationType(id)).toBe(true);
		}
		expect(isKnownNotificationType("made-up")).toBe(false);
	});

	it("says which types can still reach you when muted", () => {
		// Mixed types must advertise it: a mute on them is partial BY DESIGN, and the control
		// has to say so before someone mutes "Coder" expecting silence during a stuck run.
		expect(NOTIFICATION_TYPES.find((t) => t.id === "coding")?.alerts).toBe(true);
		expect(NOTIFICATION_TYPES.find((t) => t.id === "deploy")?.alerts).toBe(false);
	});
});
