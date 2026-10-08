/**
 * #991 — owner attention as a typed, configurable event, with the apply one-click block as its
 * first consumer rather than its owner.
 *
 * The live case: a run stopped at a control it may not press without the owner, the application
 * closed `blocked` saying "approve this application to let it be sent", and nothing told them. The
 * property these hold is that the policy is GENERIC (any agent raises the same event), that a
 * repeat of one stop does not buzz twice while a NEW stop does, and that the outcome never claims a
 * delivery that did not happen.
 */
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import {
	attentionDetail,
	attentionKey,
	attentionNotificationKey,
	attentionPushAllowed,
	type AttentionDeps,
	isOwnerAttentionEvent,
	OWNER_ATTENTION_EVENTS,
	type OwnerAttentionRequest,
	requestOwnerAttention,
	sanitizeOwnerAttentionPreferences,
} from "./owner-attention.js";

const env = {} as Env;
const REQ = (over: Partial<OwnerAttentionRequest> = {}): OwnerAttentionRequest => ({
	event: "approval_required",
	userId: "u1",
	instanceId: "ap",
	subject: { kind: "application", instanceId: "ap", applicationId: "435d31c8" },
	about: { kind: "application", id: "435d31c8", state: 20 },
	notificationType: "apply",
	title: "Approve to send: Head of Engineering at BusinessAI",
	body: "This listing's apply control can send the application in one click…",
	...over,
});
const deps = (over: Partial<AttentionDeps<Env>> = {}): AttentionDeps<Env> => ({ notify: vi.fn(async () => undefined), pushed: async () => "sent", ...over });

describe("the event vocabulary is data, usable by any agent (#991)", () => {
	it("declares each kind of attention with what it means, and what may be turned off", () => {
		expect(OWNER_ATTENTION_EVENTS.map((e) => e.id)).toEqual(["approval_required", "input_required", "blocker_required", "decision_required"]);
		for (const e of OWNER_ATTENTION_EVENTS) {
			expect(e.label.length, e.id).toBeGreaterThan(3);
			expect(e.description.length, e.id).toBeGreaterThan(20);
			// Every one is a human BLOCKED on it, which is what makes it an alert rather than news.
			expect(e.kind, e.id).toBe("alert");
		}
		expect(isOwnerAttentionEvent("approval_required")).toBe(true);
		expect(isOwnerAttentionEvent("something_invented")).toBe(false);
	});

	it("nothing in it is apply-specific — the first consumer is not the owner of the vocabulary", () => {
		const text = JSON.stringify(OWNER_ATTENTION_EVENTS).toLowerCase();
		for (const word of ["application", "apply", "seek", "résumé", "resume", "employer", "job"]) expect(text, word).not.toContain(word);
	});
});

describe("what a repeat means (#991 dedupe)", () => {
	it("one stop is ONE event, however many times a sweep re-reads it", () => {
		expect(attentionKey("approval_required", { kind: "application", id: "a1", state: 20 })).toBe(attentionKey("approval_required", { kind: "application", id: "a1", state: 20 }));
	});

	it("a stop at a NEW state is a new event — the owner retried, and it stopped again", () => {
		const first = attentionKey("approval_required", { kind: "application", id: "a1", state: 20 });
		expect(attentionKey("approval_required", { kind: "application", id: "a1", state: 23 })).not.toBe(first);
		// …and a different application, or a different kind of attention, is never the same thing.
		expect(attentionKey("approval_required", { kind: "application", id: "a2", state: 20 })).not.toBe(first);
		expect(attentionKey("input_required", { kind: "application", id: "a1", state: 20 })).not.toBe(first);
	});

	it("the identity is the EVENT, not the prose — a reworded title is still one buzz", () => {
		const a = attentionNotificationKey({ ...REQ(), title: "Approve to send: Head of Engineering" });
		const b = attentionNotificationKey({ ...REQ(), title: "Approve to send: Head of Engineering at BusinessAI (Port Melbourne)" });
		expect(b).toBe(a);
	});
});

describe("the owner's channel control", () => {
	it("keeps only events that declare their push optional, and drops anything invented", () => {
		expect(sanitizeOwnerAttentionPreferences({ pushOff: ["approval_required", "nope", 7] })).toEqual({ pushOff: ["approval_required"] });
		expect(sanitizeOwnerAttentionPreferences({ pushOff: [] })).toBeUndefined();
		expect(sanitizeOwnerAttentionPreferences("off")).toBeUndefined();
	});

	it("is per EVENT, and absent means on", () => {
		expect(attentionPushAllowed(undefined, "approval_required")).toBe(true);
		expect(attentionPushAllowed({ pushOff: ["approval_required"] }, "approval_required")).toBe(false);
		expect(attentionPushAllowed({ pushOff: ["approval_required"] }, "input_required")).toBe(true);
		// An unknown event is not silently suppressed.
		expect(attentionPushAllowed({ pushOff: ["x"] }, "x")).toBe(true);
	});
});

describe("raising it, and saying truthfully what happened", () => {
	it("records the row, deep links where the control IS, and reports the push", async () => {
		const notify = vi.fn<AttentionDeps<Env>["notify"]>(async () => undefined);
		const out = await requestOwnerAttention(env, REQ(), deps({ notify }));
		expect(out).toMatchObject({ event: "approval_required", recorded: true, push: "sent" });
		// The Board, where the Approve control renders — not a URL that does not resolve.
		expect(out.url).toMatch(/\/instances\/ap\/board$/);
		const [, userId, type, title, , url, opts] = notify.mock.calls[0];
		expect({ userId, type, url }).toEqual({ userId: "u1", type: "apply", url: out.url });
		expect(title).toMatch(/Approve to send/);
		// An alert, because a person is blocked — and carrying the instance so the account's scope applies.
		expect(opts).toMatchObject({ kind: "alert", instanceId: "ap", key: out.key });
		expect(out.detail).toMatch(/the owner was notified/);
	});

	it("hands the push check the key the notifications table STORES, not the raw one", async () => {
		// The column holds a hash of (type, event key, title, body). A consumer that looked the row
		// up by the raw attention key would find nothing and report every delivered push as
		// `unavailable` — the precise lie this module exists to prevent, wearing a truthful face.
		const pushed = vi.fn<NonNullable<AttentionDeps<Env>["pushed"]>>(async () => "sent");
		const req = REQ();
		const out = await requestOwnerAttention(env, req, deps({ pushed }));
		expect(pushed.mock.calls[0][2]).toEqual({ key: out.key, dedupeKey: attentionNotificationKey(req) });
		expect(attentionNotificationKey(req)).not.toContain(out.key);
	});

	it("DEGRADES TRUTHFULLY: no push delivered is never reported as notified", async () => {
		const out = await requestOwnerAttention(env, REQ(), deps({ pushed: async () => "unavailable" }));
		expect(out).toMatchObject({ recorded: true, push: "unavailable" });
		expect(out.detail).toMatch(/no push could be delivered/);
		expect(out.detail).not.toMatch(/the owner was notified/);
		// It is still in their notifications — the bell list is the log, and says so.
		expect(out.detail).toMatch(/in the owner's notifications/);
	});

	it("a suppressed repeat says it did not buzz again, rather than claiming a send", async () => {
		const out = await requestOwnerAttention(env, REQ(), deps({ pushed: async () => "deduped" }));
		expect(out.push).toBe("deduped");
		expect(out.detail).toMatch(/already sent, so it did not buzz again/);
	});

	it("the owner's own push-off still records the row, and reports `muted`", async () => {
		const notify = vi.fn<AttentionDeps<Env>["notify"]>(async () => undefined);
		const out = await requestOwnerAttention(env, REQ(), deps({ notify, preferences: async () => ({ attention: { pushOff: ["approval_required"] } }) }));
		expect(out.push).toBe("muted");
		expect(out.recorded, "the log is never optional").toBe(true);
		expect(out.detail).toMatch(/turned this event's push off/);
		// Written as an update, not an alert: the owner asked for no interruption from this event.
		expect(notify.mock.calls[0][6]).toMatchObject({ kind: "update" });
	});

	it("a delivery that throws is reported as not notified — it never fails the caller", async () => {
		const out = await requestOwnerAttention(env, REQ(), deps({ notify: vi.fn(async () => { throw new Error("D1 down"); }) }));
		expect(out).toMatchObject({ recorded: false, push: "unavailable" });
		expect(out.detail).toMatch(/nothing could be recorded for the owner, so they have not been told/);
	});

	it("every outcome sentence names what reached the owner", () => {
		for (const push of ["sent", "muted", "deduped", "unavailable"] as const) {
			expect(attentionDetail("approval_required", push, true), push).toMatch(/Approval needed/);
		}
		expect(attentionDetail("approval_required", "sent", false)).toMatch(/have not been told/);
	});
});
