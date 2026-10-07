/**
 * Every notification opens what it is about (#897, from the #894 audit).
 *
 * - A producer that names no link no longer lands on `/console/` (the home screen): it opens the
 *   instance it concerns, or the feed, and the omission is logged so it gets fixed.
 * - The OS tray entry is per SUBJECT, not per type: a "Coder finished" for one session no longer
 *   replaces a "Coder needs you" for another, link and all.
 * - The sign-in notifications find the run that waits on (or was stopped by) the sign-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkConsoleLink } from "../../../../store/console/src/lib/routes";
import { signInSessionId } from "../lib/engine-reauth-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";
import { notificationTag, notificationTarget, notifyUser } from "./push.js";

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterEach(() => d1.close());

const env = () => ({ DB: d1.DB }) as unknown as Env;

describe("notificationTarget — a missing link is a logged bug, never the home screen", () => {
	it("keeps the link a producer gave", () => {
		expect(notificationTarget("/console/instances/i1/coding/s1", "i1")).toEqual({ url: "/console/instances/i1/coding/s1", missing: false });
	});

	it("falls back to the instance it concerns, else the feed — both real pages", () => {
		for (const [url, instanceId, expected] of [
			[undefined, "i1", "/console/instances/i1"],
			["  ", "i1", "/console/instances/i1"],
			["", undefined, "/console/notifications"],
		] as const) {
			const t = notificationTarget(url, instanceId);
			expect(t).toEqual({ url: expected, missing: true });
			expect(checkConsoleLink(t.url).ok).toBe(true);
		}
	});

	it("notifyUser stores the fallback on the row and logs the producer that forgot", async () => {
		// `url` is required by type; a caller that defeats it at runtime is the case this guards.
		await notifyUser(env(), "u1", "coding", "🔑 Coding engine signed in", "body", undefined as unknown as string, { instanceId: "i1" });
		const row = await d1.DB.prepare("SELECT url FROM notifications WHERE user_id = 'u1'").first<{ url: string }>();
		expect(row?.url).toBe("/console/instances/i1");
		const logged = await d1.DB.prepare("SELECT source, level, message FROM error_log WHERE user_id = 'u1'").first<{ source: string; level: string; message: string }>();
		// `error` since #894: unreachable from TypeScript, so reaching it is a defect worth surfacing.
		expect(logged).toMatchObject({ source: "push", level: "error" });
		expect(logged?.message).toContain("no deep link");
	});

	it("logs nothing for a producer that named its page", async () => {
		await notifyUser(env(), "u1", "deploy", "✅ Deployed", "body", "/console/instances/i1/coding?builds=r1", { instanceId: "i1" });
		expect(await d1.DB.prepare("SELECT 1 FROM error_log WHERE user_id = 'u1'").first()).toBeNull();
		expect((await d1.DB.prepare("SELECT url FROM notifications WHERE user_id = 'u1'").first<{ url: string }>())?.url).toBe("/console/instances/i1/coding?builds=r1");
	});
});

describe("notificationTag — one tray entry per subject", () => {
	it("keeps different subjects of one type apart", () => {
		const needsYou = notificationTag("coding", "/console/instances/i1/coding/s-a");
		const finished = notificationTag("coding", "/console/instances/i1/coding/s-b");
		expect(needsYou).not.toBe(finished);
	});

	it("still collapses repeats about the same subject — the next deploy of a repo replaces the last", () => {
		const url = "/console/instances/i1/coding?builds=r1";
		expect(notificationTag("deploy", url)).toBe(notificationTag("deploy", url));
		expect(notificationTag("deploy", url)).not.toBe(notificationTag("deploy", "/console/instances/i1/coding?builds=r2"));
	});
});

describe("signInSessionId — the run a sign-in notification is about", () => {
	const run = (id: string, startedAt: number, fields: { session?: string | null; status?: string; waiting?: string | null; stop?: string | null }) =>
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason, stop_reason)
		         VALUES ('${id}', 'u1', 'i1', 'x', '${fields.status ?? "running"}', 10, ${startedAt}, ${fields.session ? `'${fields.session}'` : "NULL"},
		                 ${fields.waiting ? `'${fields.waiting}'` : "NULL"}, ${fields.stop ? `'${fields.stop}'` : "NULL"})`);

	it("is the latest run's session when that run is parked on sign-in", async () => {
		run("r1", 1, { session: "s-old", status: "completed" });
		run("r2", 2, { session: "s-parked", waiting: "engine_auth" });
		expect(await signInSessionId(env(), "i1", "u1")).toBe("s-parked");
	});

	it("is the latest run's session when sign-in stopped it", async () => {
		run("r1", 1, { session: "s-stopped", status: "stopped", stop: "engine_auth" });
		expect(await signInSessionId(env(), "i1", "u1")).toBe("s-stopped");
	});

	it("is null when the latest run has nothing to do with sign-in, or there is none", async () => {
		expect(await signInSessionId(env(), "i1", "u1")).toBeNull();
		run("r1", 1, { session: "s-busy" });
		expect(await signInSessionId(env(), "i1", "u1")).toBeNull();
	});
});
