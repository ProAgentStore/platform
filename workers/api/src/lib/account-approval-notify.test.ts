import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";

const sent: unknown[][] = [];
let outcome: string | Error = "sent";
vi.mock("../routes/push.js", () => ({
	notifyUser: async (...args: unknown[]) => {
		sent.push(args);
		if (outcome instanceof Error) throw outcome;
		return outcome;
	},
}));

import { ACCOUNT_APPROVAL_NOTIFICATION, approvalPushText, notifyApprovalRequested } from "./account-approval-notify.js";
import { createChange, listEvents } from "./account-change-requests.js";
import { buildDiffPreview, actionById } from "./approval-gate.js";

let d1: RealSchemaD1;
let env: Env;
const make = async () => {
	const preview = buildDiffPreview(actionById("repo_add")!, { method: "POST", path: "/v1/instances/i1/coding/repos", params: { id: "i1" }, body: { repo: "acme/app", token: "ghp_X" }, before: {} });
	const { request } = await createChange(env, { userId: "u1", actorUserId: "u1", action: "repo_add", targetDescription: preview.target, method: "POST", path: preview.path, bodyEncrypted: "{}", diffPreview: preview, beforeFingerprint: "f", requestFingerprint: "r", expiresAt: Date.now() + 60_000 });
	return { request, preview };
};

beforeEach(() => {
	sent.length = 0;
	outcome = "sent";
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
});

describe("the approval push (#1268)", () => {
	it("is an alert of its own type, deep-linked to the exact request, and says nothing has changed", async () => {
		const { request, preview } = await make();
		expect(await notifyApprovalRequested(env, request, preview)).toBe("sent");
		const [, userId, type, title, body, url, opts] = sent[0] as [unknown, string, string, string, string, string, Record<string, unknown>];
		expect([userId, type]).toEqual(["u1", ACCOUNT_APPROVAL_NOTIFICATION]);
		expect(title).toContain("Approve");
		expect(body).toMatch(/Nothing has changed yet/);
		expect(body).toContain("repo: acme/app");
		expect(body).not.toContain("ghp_X");
		expect(url).toBe(`/console/preferences?approval=${request.id}`);
		expect(opts).toMatchObject({ kind: "alert", event: "approval_required", key: `account-approval:${request.id}` });
	});

	it("records the outcome on the audit trail, and a push that throws is recorded as unavailable — never raised", async () => {
		const { request, preview } = await make();
		outcome = new Error("push service down");
		expect(await notifyApprovalRequested(env, request, preview)).toBe("unavailable");
		const events = await listEvents(env, request.id, "u1");
		expect(events.map((e) => e.event)).toEqual(["request.created", "notification.outcome"]);
		expect(events[1].detail).toEqual({ outcome: "unavailable" });
	});

	it("muted pushes are recorded as muted (the request is still waiting in Preferences)", async () => {
		const { request, preview } = await make();
		outcome = "muted";
		expect(await notifyApprovalRequested(env, request, preview)).toBe("muted");
	});

	it("approvalPushText names the target and the label", () => {
		expect(approvalPushText({ targetDescription: "Add a/b to instance i" }, { label: "Add a repo", summary: "repo: a/b" })).toEqual({ title: "Approve: Add a repo", body: "Add a/b to instance i. Nothing has changed yet. Open to review the exact change and approve or deny it.\nrepo: a/b" });
	});
});
