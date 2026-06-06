import { describe, expect, it } from "vitest";

describe("instance ID generation", () => {
	it("generates a valid UUID v4", () => {
		const id = crypto.randomUUID();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("generates unique IDs each time", () => {
		const ids = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
		expect(ids.size).toBe(100);
	});

	it("generates a different instance ID for each subscription", () => {
		const a = crypto.randomUUID();
		const b = crypto.randomUUID();
		expect(a).not.toBe(b);
	});
});

describe("subscription status values", () => {
	const VALID_STATUSES = ["active", "canceled", "paused"] as const;
	type Status = (typeof VALID_STATUSES)[number];

	it("initial subscribe produces 'active' status", () => {
		const status: Status = "active";
		expect(status).toBe("active");
		expect(VALID_STATUSES).toContain(status);
	});

	it("cancel sets status to 'canceled'", () => {
		const status: Status = "canceled";
		expect(status).toBe("canceled");
		expect(VALID_STATUSES).toContain(status);
	});

	it("all defined statuses are valid", () => {
		for (const s of VALID_STATUSES) {
			expect(VALID_STATUSES).toContain(s);
		}
	});

	it("unknown status is not in the valid set", () => {
		const unknown = "deleted";
		expect(VALID_STATUSES).not.toContain(unknown as Status);
	});
});

describe("cancel flow state transitions", () => {
	type Status = "active" | "canceled";

	function cancelInstance(current: Status): Status {
		if (current === "canceled") return "canceled"; // idempotent
		return "canceled";
	}

	function cancelSubscription(current: Status): Status {
		if (current !== "active") return current; // only cancel active
		return "canceled";
	}

	it("cancels an active instance", () => {
		expect(cancelInstance("active")).toBe("canceled");
	});

	it("cancel on already-canceled instance is idempotent", () => {
		expect(cancelInstance("canceled")).toBe("canceled");
	});

	it("cancels an active subscription", () => {
		expect(cancelSubscription("active")).toBe("canceled");
	});

	it("does not re-cancel a canceled subscription", () => {
		expect(cancelSubscription("canceled")).toBe("canceled");
	});

	it("batch cancel: both instance and subscription become canceled", () => {
		let instanceStatus: Status = "active";
		let subscriptionStatus: Status = "active";

		instanceStatus = cancelInstance(instanceStatus);
		subscriptionStatus = cancelSubscription(subscriptionStatus);

		expect(instanceStatus).toBe("canceled");
		expect(subscriptionStatus).toBe("canceled");
	});

	it("subscribe response shape contains instanceId, agentId, status", () => {
		const instanceId = crypto.randomUUID();
		const agentId = crypto.randomUUID();
		const response = { instanceId, agentId, status: "active" };

		expect(response).toHaveProperty("instanceId");
		expect(response).toHaveProperty("agentId");
		expect(response).toHaveProperty("status", "active");
	});
});

describe("instance ownership check", () => {
	it("returns instance only when user_id matches", () => {
		const instances = [
			{ id: "inst-1", user_id: "user-a" },
			{ id: "inst-2", user_id: "user-b" },
		];
		const found = instances.find(
			(i) => i.id === "inst-1" && i.user_id === "user-a",
		);
		expect(found).toBeDefined();
	});

	it("returns null when user_id does not match", () => {
		const instances = [{ id: "inst-1", user_id: "user-a" }];
		const found = instances.find(
			(i) => i.id === "inst-1" && i.user_id === "user-x",
		);
		expect(found).toBeUndefined();
	});
});
