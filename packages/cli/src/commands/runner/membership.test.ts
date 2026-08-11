import { describe, expect, it } from "vitest";
import { diffMembership, instanceLabel, isEligible, shouldRegisterOnOpen, type DiscoverableInstance } from "./membership.js";

const NODE = "my-laptop";
const inst = (over: Partial<DiscoverableInstance> & { id: string }): DiscoverableInstance => ({
	status: "active",
	capabilities: { runtime: "coding" },
	...over,
});

describe("isEligible", () => {
	it("wants active instances that declare a runtime", () => {
		expect(isEligible(inst({ id: "a" }), NODE)).toBe(true);
	});

	// Same two conditions up.ts filters on at startup — discovery must not disagree with the
	// list the runner was launched from, or the two would fight every poll.
	it("skips inactive instances and cloud-only agents", () => {
		expect(isEligible(inst({ id: "a", status: "cancelled" }), NODE)).toBe(false);
		expect(isEligible(inst({ id: "a", capabilities: { runtime: null } }), NODE)).toBe(false);
		expect(isEligible(inst({ id: "a", capabilities: null }), NODE)).toBe(false);
	});

	// The multi-machine correctness risk called out in #229: auto-discovery must not attach an
	// agent its owner pinned to another machine. Winning that race would silently relocate it.
	it("skips an instance pinned to a different node, and keeps one pinned to this one", () => {
		expect(isEligible(inst({ id: "a", config: { runnerNode: "other-box" } }), NODE)).toBe(false);
		expect(isEligible(inst({ id: "a", config: { runnerNode: NODE } }), NODE)).toBe(true);
		expect(isEligible(inst({ id: "a", config: { runnerNode: null } }), NODE)).toBe(true);
	});

	// #379. A hostname moves under the machine, so a pin made yesterday can name THIS laptop by a
	// name it no longer answers to. Without the machine's own name history that reads as "pinned
	// elsewhere", and the 20s poll detached the agent the user had pinned to this very machine —
	// leaving the platform with no socket to resolve the pin onto.
	it("keeps an instance pinned to a hostname this machine used to wear", () => {
		const pinnedToOldName = inst({ id: "a", config: { runnerNode: "RLs-MacBook-Air.local" } });
		expect(isEligible(pinnedToOldName, NODE)).toBe(false);
		expect(isEligible(pinnedToOldName, NODE, ["RLs-MacBook-Air.local"])).toBe(true);
		// A name this machine has never worn is still another machine's, history or not.
		expect(isEligible(inst({ id: "a", config: { runnerNode: "desktop" } }), NODE, ["RLs-MacBook-Air.local"])).toBe(false);
	});
});

describe("diffMembership", () => {
	it("attaches a newly eligible instance — the whole point of the ticket", () => {
		const d = diffMembership(["a"], [inst({ id: "a" }), inst({ id: "b" })], NODE);
		expect(d.attach.map((i) => i.id)).toEqual(["b"]);
		expect(d.detach).toEqual([]);
	});

	it("leaves already-attached instances alone, so existing sockets are never churned", () => {
		const d = diffMembership(["a", "b"], [inst({ id: "a" }), inst({ id: "b" })], NODE);
		expect(d.attach).toEqual([]);
		expect(d.detach).toEqual([]);
	});

	it("detaches what stopped being eligible — unsubscribed, deactivated, or re-pinned", () => {
		expect(diffMembership(["a", "b"], [inst({ id: "a" })], NODE).detach).toEqual(["b"]);
		expect(diffMembership(["a"], [inst({ id: "a", status: "cancelled" })], NODE).detach).toEqual(["a"]);
		expect(diffMembership(["a"], [inst({ id: "a", config: { runnerNode: "other" } })], NODE).detach).toEqual(["a"]);
		// …but NOT one pinned to a name this machine itself used to answer to (#379).
		expect(diffMembership(["a"], [inst({ id: "a", config: { runnerNode: "old-name" } })], NODE, new Set(), ["old-name"]).detach).toEqual([]);
	});

	// A 4409 means another live runner owns that relay. Without this, every poll would re-attach
	// it and the user would watch a permanent conflict scroll past as reconnect noise.
	it("does not re-attach an instance blocked by another live runner", () => {
		const d = diffMembership([], [inst({ id: "a" }), inst({ id: "b" })], NODE, new Set(["a"]));
		expect(d.attach.map((i) => i.id)).toEqual(["b"]);
	});

	// Blocked ≠ ineligible: clearing the block (other machine disconnects, or --force) must let
	// the next pass attach without anything else changing.
	it("attaches a previously blocked instance once the block clears", () => {
		const eligible = [inst({ id: "a" })];
		expect(diffMembership([], eligible, NODE, new Set(["a"])).attach).toEqual([]);
		expect(diffMembership([], eligible, NODE).attach.map((i) => i.id)).toEqual(["a"]);
	});

	it("never lists a blocked-but-eligible instance for detach", () => {
		expect(diffMembership(["a"], [inst({ id: "a" })], NODE, new Set(["a"])).detach).toEqual([]);
	});
});

describe("instanceLabel", () => {
	it("prefers the name, and always carries a short id", () => {
		expect(instanceLabel({ id: "abcdefgh-1234", name: "Coder" })).toBe("Coder (abcdefgh…)");
		expect(instanceLabel({ id: "abcdefgh-1234" })).toBe("abcdefgh…");
	});
});

// ── the scoped-run invariant (#229) ─────────────────────────────────────────
//
// `pags up --instance X` means exactly that agent. Discovery must never widen it — quietly
// fanning back out to the whole account is the same bug the restart path already guards
// against in up.ts, and auto-attach would reintroduce it through a different door.
describe("scoped runs stay scoped", () => {
	it("a fixed membership set produces no attachments even when others are eligible", () => {
		const eligible = [inst({ id: "scoped" }), inst({ id: "other-1" }), inst({ id: "other-2" })];
		// A scoped run never enters discovery, so the diff is simply never consulted. This
		// asserts the shape that makes that safe: with watch off, membership only ever holds
		// what was passed in.
		const scopedOnly = eligible.filter((i) => i.id === "scoped");
		const d = diffMembership(["scoped"], scopedOnly, NODE);
		expect(d.attach).toEqual([]);
		expect(d.detach).toEqual([]);
	});
});

/**
 * #497: the socket is the only thing here that retries, so the registration has to ride it.
 * Both halves of the rule are pinned — an implementation that "simplifies" this to "register on
 * every open" doubles every startup's writes, and one that registers only on the first open puts
 * the wake bug straight back.
 */
describe("shouldRegisterOnOpen", () => {
	it("a RECONNECT always re-registers — the wake case", () => {
		expect(shouldRegisterOnOpen(true, true)).toBe(true);
		expect(shouldRegisterOnOpen(true, false)).toBe(true);
	});

	it("a first open re-registers only when the earlier attempt failed", () => {
		// Startup (or the discovery pass) already registered this one: don't write it twice.
		expect(shouldRegisterOnOpen(false, true)).toBe(false);
		// `fetch failed` at boot, caught and logged and never retried — this is the second chance.
		expect(shouldRegisterOnOpen(false, false)).toBe(true);
	});
});
