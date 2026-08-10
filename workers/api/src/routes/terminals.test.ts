import { describe, expect, it } from "vitest";
import { diagnoseForget, diagnoseUnclaim, groupTerminalNodes } from "./terminals.js";

const nodeRow = (over: Partial<Parameters<typeof groupTerminalNodes>[0][number]> = {}) => ({
	instance_id: "i1", runner_node: "macbook", placement: "local", runner_version: "0.4.16",
	status: "active", last_seen_at: "2026-07-14T10:00:00Z", updated_at: "2026-07-14T10:00:00Z",
	machine_id: null,
	instance_config: null, agent_name: "Coder", agent_slug: "coder", agent_category: null, agent_config: null, ...over,
});
const sessionRow = (over: Partial<Parameters<typeof groupTerminalNodes>[1][number]> = {}) => ({
	id: "s1", instance_id: "i1", repo_id: "r1", runner_node: "macbook", client_type: "claude",
	status: "active", issue_number: null, issue_title: null, updated_at: "2026-07-14T10:00:00Z", repo_name: "pags/platform", ...over,
});

describe("groupTerminalNodes", () => {
	it("groups per-instance registrations into one machine, deduping instances", () => {
		// The same machine serves two runner-using instances → one node with two instances.
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", agent_name: "Coder" }),
			nodeRow({ instance_id: "i2", agent_name: "Applier", agent_slug: "job-application-assistant" }),
			nodeRow({ instance_id: "i1" }), // duplicate registration for i1 (older row) — deduped
		], []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].node).toBe("macbook");
		expect(nodes[0].instances.map((i) => i.instanceId)).toEqual(["i1", "i2"]);
		expect(nodes[0].instances[0].name).toBe("Coder");
	});

	it("excludes runner-less agents (chat/RAG) and drops a machine that has only them", () => {
		// Multiplexed `pags up` registers every instance, but repo-chat/doc-chat (runtime:null)
		// never touch a runner — they must not appear on a Terminals view.
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", agent_name: "Coder", agent_slug: "coder" }),
			nodeRow({ instance_id: "i2", agent_name: "Repo Chat", agent_slug: "repo-chat" }),
		], []);
		expect(nodes[0].instances.map((i) => i.instanceId)).toEqual(["i1"]); // repo-chat excluded

		// A machine whose ONLY agents are runner-less + no sessions is dropped entirely.
		const empty = groupTerminalNodes([nodeRow({ instance_id: "i9", agent_slug: "repo-chat", runner_node: "chat-only" })], []);
		expect(empty).toHaveLength(0);
	});

	it("separates distinct machines", () => {
		const nodes = groupTerminalNodes([nodeRow({ runner_node: "macbook" }), nodeRow({ runner_node: "desktop", instance_id: "i2" })], []);
		expect(nodes.map((n) => n.node).sort()).toEqual(["desktop", "macbook"]);
	});

	it("prefers the instance's renamed displayName over the agent name", () => {
		const nodes = groupTerminalNodes([nodeRow({ instance_config: JSON.stringify({ displayName: "My FGS coder" }) })], []);
		expect(nodes[0].instances[0].name).toBe("My FGS coder");
	});

	it("attaches node-pinned sessions to their machine (with repo + issue)", () => {
		const nodes = groupTerminalNodes([nodeRow()], [sessionRow({ id: "s1", issue_number: 12, issue_title: "Fix login" })]);
		expect(nodes[0].sessions).toHaveLength(1);
		expect(nodes[0].sessions[0]).toMatchObject({ sessionId: "s1", repoName: "pags/platform", engine: "claude", issueNumber: 12, issueTitle: "Fix login" });
	});

	it("ignores a session whose machine has no registration row (orphan)", () => {
		const nodes = groupTerminalNodes([nodeRow({ runner_node: "macbook" })], [sessionRow({ runner_node: "ghost" })]);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].sessions).toHaveLength(0);
	});

	it("defaults connection flags to false (the route fills them from live relay checks)", () => {
		const nodes = groupTerminalNodes([nodeRow()], []);
		expect(nodes[0].connected).toBe(false);
		expect(nodes[0].instances[0].connected).toBe(false);
	});

	it("marks an instance bound when its config pins runnerNode to this machine", () => {
		const nodes = groupTerminalNodes([
			nodeRow({ runner_node: "macbook", instance_config: JSON.stringify({ runnerNode: "macbook" }) }),
			nodeRow({ runner_node: "desktop", instance_id: "i2", instance_config: JSON.stringify({ runnerNode: "macbook" }) }),
		], []);
		const mac = nodes.find((n) => n.node === "macbook")!;
		const desk = nodes.find((n) => n.node === "desktop")!;
		expect(mac.instances[0].bound).toBe(true);  // pinned here
		expect(desk.instances[0].bound).toBe(false); // pinned elsewhere → merely served here
	});

	it("leaves bound false when no pin is set", () => {
		const nodes = groupTerminalNodes([nodeRow()], []);
		expect(nodes[0].instances[0].bound).toBe(false);
	});

	it("skips rows with an empty runner_node", () => {
		expect(groupTerminalNodes([nodeRow({ runner_node: "" })], [])).toHaveLength(0);
	});
});

describe("groupTerminalNodes — one machine, several names (#393)", () => {
	// The reported screen: one laptop rendered as three machines, two of them permanently offline,
	// because a registration is keyed by a hostname that moves under the machine (#379).
	const renamed = [
		nodeRow({ runner_node: "Mac", machine_id: "machine-aaaa1111", last_seen_at: "2026-08-08T09:00:00Z" }),
		nodeRow({ runner_node: "RLs-MacBook-Air.local", machine_id: "machine-aaaa1111", last_seen_at: "2026-08-07T09:00:00Z" }),
		nodeRow({ runner_node: "RLs-MacBook-Air", machine_id: "machine-aaaa1111", last_seen_at: "2026-07-16T22:00:00Z" }),
	];

	it("folds every name of one machine into a single entry, freshest name winning", () => {
		const nodes = groupTerminalNodes(renamed, []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].node).toBe("Mac");
		expect(nodes[0].machineId).toBe("machine-aaaa1111");
		expect(nodes[0].aka).toEqual(["RLs-MacBook-Air.local", "RLs-MacBook-Air"]);
	});

	it("takes the freshest name whatever order the rows arrive in", () => {
		const nodes = groupTerminalNodes([...renamed].reverse(), []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].node).toBe("Mac");
		expect(nodes[0].aka).toContain("RLs-MacBook-Air.local");
	});

	it("keeps TWO machines apart even when their hostnames are identical", () => {
		// The inverse hazard: identity is the id each machine persists, never the name. Two Macs
		// must never merge just because DHCP called them the same thing.
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", runner_node: "Mac", machine_id: "machine-aaaa1111" }),
			nodeRow({ instance_id: "i2", runner_node: "Mac", machine_id: "machine-bbbb2222" }),
		], []);
		expect(nodes).toHaveLength(2);
		expect(nodes.map((n) => n.machineId).sort()).toEqual(["machine-aaaa1111", "machine-bbbb2222"]);
	});

	it("leaves rows with no machine id separate — without the proof they ARE separate", () => {
		const nodes = groupTerminalNodes([
			nodeRow({ runner_node: "Mac", machine_id: null }),
			nodeRow({ runner_node: "RLs-MacBook-Air.local", machine_id: null }),
		], []);
		expect(nodes).toHaveLength(2);
		expect(nodes.every((n) => n.machineId === null)).toBe(true);
		expect(nodes.every((n) => n.aka.length === 0)).toBe(true);
	});

	it("gathers the sessions of every name onto the one machine", () => {
		const nodes = groupTerminalNodes(renamed, [
			sessionRow({ id: "s-new", runner_node: "Mac" }),
			sessionRow({ id: "s-old", runner_node: "RLs-MacBook-Air.local" }),
		]);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].sessions.map((s) => s.sessionId).sort()).toEqual(["s-new", "s-old"]);
	});

	it("marks an instance bound when it is pinned to an OLDER name of this machine", () => {
		// The live defect this fixes: six instances pinned to a name the laptop stopped using still
		// route here via aliasing, so rendering them as unbound contradicts what actually happens.
		const cfg = JSON.stringify({ runnerNode: "RLs-MacBook-Air.local" });
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", runner_node: "Mac", machine_id: "machine-aaaa1111", instance_config: cfg, last_seen_at: "2026-08-08T09:00:00Z" }),
			nodeRow({ instance_id: "i1", runner_node: "RLs-MacBook-Air.local", machine_id: "machine-aaaa1111", instance_config: cfg, last_seen_at: "2026-08-07T09:00:00Z" }),
		], []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].instances).toHaveLength(1);
		expect(nodes[0].instances[0].bound).toBe(true);
	});

	it("does not mark an instance bound to a DIFFERENT machine", () => {
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", runner_node: "Mac", machine_id: "machine-aaaa1111", instance_config: JSON.stringify({ runnerNode: "Sergeys-Mac-mini.local" }) }),
			nodeRow({ instance_id: "i2", runner_node: "Sergeys-Mac-mini.local", machine_id: "machine-bbbb2222" }),
		], []);
		const mac = nodes.find((n) => n.node === "Mac");
		expect(mac?.instances[0].bound).toBe(false);
	});
});

describe("groupTerminalNodes — an id carried by only SOME rows of a hostname", () => {
	// Found in production, not in review. There is one row per (instance, hostname), and a
	// `pags up` stamps the machine id on the instances it registers — an instance it did not
	// attach keeps NULL under the SAME hostname. Keying the group off whichever row arrived first
	// split one machine in two, and when the NULL row came first it folded nothing at all.
	it("folds when the id is present on one row of a name and absent on another", () => {
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i-unattached", runner_node: "Mac", machine_id: null, last_seen_at: "2026-08-08T09:00:00Z" }),
			nodeRow({ instance_id: "i-attached", runner_node: "Mac", machine_id: "machine-aaaa1111", last_seen_at: "2026-08-08T09:00:00Z" }),
			nodeRow({ instance_id: "i-attached", runner_node: "RLs-MacBook-Air.local", machine_id: "machine-aaaa1111", last_seen_at: "2026-08-07T09:00:00Z" }),
		], []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].node).toBe("Mac");
		expect(nodes[0].machineId).toBe("machine-aaaa1111");
		expect(nodes[0].aka).toEqual(["RLs-MacBook-Air.local"]);
		expect(nodes[0].instances.map((i) => i.instanceId).sort()).toEqual(["i-attached", "i-unattached"]);
	});

	it("does not let an AMBIGUOUS name adopt an identity", () => {
		// Two laptops both called "Mac", each serving a different instance, plus an unidentified row
		// under the same name. The two identified machines stay apart — a hostname is not an
		// identity and must never transfer one — and the unidentified row stays on the name, which
		// is the honest answer: we know those two are separate and we do not know about the third.
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", runner_node: "Mac", machine_id: "machine-aaaa1111" }),
			nodeRow({ instance_id: "i2", runner_node: "Mac", machine_id: "machine-bbbb2222" }),
			nodeRow({ instance_id: "i3", runner_node: "Mac", machine_id: null }),
		], []);
		expect(nodes).toHaveLength(3);
		expect(nodes.map((n) => n.machineId).sort()).toEqual(["machine-aaaa1111", "machine-bbbb2222", null]);
	});

	it("ignores an id the platform could never have stored", () => {
		// This page used to accept any non-empty string as an identity, while `aliasNodesFor` and
		// `foldNodesByMachine` read the same column through `normalizeMachineId` — so a value the
		// ROUTING rejects could still fold two names together here. Registration only ever writes an
		// id through that same gate (instances.ts), so nothing legitimate is lost, and the three
		// surfaces now answer the identity question identically. Two surfaces disagreeing about one
		// machine is #393 itself.
		const nodes = groupTerminalNodes([
			nodeRow({ instance_id: "i1", runner_node: "Mac", machine_id: "m-1" }),
			nodeRow({ instance_id: "i2", runner_node: "RLs-MacBook-Air.local", machine_id: "m-1" }),
		], []);
		expect(nodes).toHaveLength(2);
		expect(nodes.map((n) => n.machineId)).toEqual([null, null]);
	});
});

describe("identityHint on a grouped machine (#393)", () => {
	it("tells a machine on a pre-0.4.40 CLI why it has not merged", () => {
		// The reported state: every row NULL, so `foldNodesByMachine` had nothing to fold and the
		// user saw one laptop as three machines with no indication that the fix had not reached it.
		const nodes = groupTerminalNodes([nodeRow({ machine_id: null, runner_version: "0.4.35" })], []);
		expect(nodes[0].identityHint).toContain("0.4.35");
		expect(nodes[0].identityHint).toContain("0.4.40");
	});

	it("says nothing about a machine that has an identity", () => {
		const nodes = groupTerminalNodes([nodeRow({ machine_id: "machine-aaaa1111", runner_version: "0.4.43" })], []);
		expect(nodes[0].identityHint).toBe(null);
	});

	it("reads the version off the FRESHEST registration, not a stale row", () => {
		// A machine that has since upgraded must not keep being told to upgrade by a row it left
		// behind — that is #379's "the one remedy is the thing you already did", repeated.
		const nodes = groupTerminalNodes([
			nodeRow({ runner_node: "old-name", machine_id: "machine-aaaa1111", runner_version: "0.4.35", last_seen_at: "2026-07-16T10:00:00Z" }),
			nodeRow({ runner_node: "Mac", machine_id: "machine-aaaa1111", runner_version: "0.4.43", last_seen_at: "2026-08-08T06:39:00Z" }),
		], []);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].runnerVersion).toBe("0.4.43");
		expect(nodes[0].identityHint).toBe(null);
	});
});

describe("diagnoseForget (#393 — forgetting must not orphan what points here)", () => {
	it("allows forgetting a machine nothing references", () => {
		expect(diagnoseForget(false, [])).toEqual({ ok: true });
	});

	it("refuses a machine that is connected right now", () => {
		// It would re-register within a heartbeat, so the button would look broken, not refused.
		const v = diagnoseForget(true, []);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("connected");
		expect(v.message).toContain("pags up");
	});

	// THE invariant. The node row is not merely a listing — `aliasNodesFor` reads `machine_id` off
	// exactly these rows to route a stranded pin onto the name the machine wears now. Deleting them
	// while an agent is pinned here would break an agent that #379 had already healed, and leave the
	// user with less evidence on screen than before.
	it("refuses while an agent is still pinned here, and names it", () => {
		const v = diagnoseForget(false, [{ kind: "pin", id: "i1", label: "Heartfull", node: "RLs-MacBook-Air.local" }]);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("pinned");
		expect(v.message).toContain("Heartfull");
		expect(v.message).toContain("RLs-MacBook-Air.local");
	});

	it("refuses while a coding session is still open here", () => {
		const v = diagnoseForget(false, [{ kind: "session", id: "s1", label: "pags/platform", node: "Mac" }]);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("sessions");
		expect(v.message).toContain("pags/platform");
	});

	it("reports the PIN first when both block — it is the one that breaks routing", () => {
		const v = diagnoseForget(false, [
			{ kind: "session", id: "s1", label: "repo", node: "Mac" },
			{ kind: "pin", id: "i1", label: "Heartfull", node: "Mac" },
		]);
		expect(v.ok === false && v.reason).toBe("pinned");
	});
});

describe("diagnoseUnclaim (#467 — un-claiming must not strand what routes only through this alias)", () => {
	it("allows un-claiming a name nothing else depends on", () => {
		expect(diagnoseUnclaim(false, [])).toEqual({ ok: true });
	});

	it("refuses when the machine is connected (next heartbeat would re-stamp)", () => {
		const v = diagnoseUnclaim(true, []);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("connected");
		expect(v.message).toContain("pags up");
	});

	it("refuses when a pin would be stranded by the identity disappearing, and names it", () => {
		const v = diagnoseUnclaim(false, [{ kind: "pin", id: "i1", label: "My Coder", node: "RLs-MacBook-Air.local" }]);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("pinned");
		expect(v.message).toContain("My Coder");
		expect(v.message).toContain("RLs-MacBook-Air.local");
	});

	it("refuses when an open session would be stranded", () => {
		const v = diagnoseUnclaim(false, [{ kind: "session", id: "s1", label: "pags/platform", node: "Mac" }]);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe("sessions");
		expect(v.message).toContain("pags/platform");
	});

	it("reports connected first, pins second, sessions third", () => {
		const v = diagnoseUnclaim(true, [{ kind: "session", id: "s1", label: "repo", node: "Mac" }]);
		expect(v.ok === false && v.reason).toBe("connected");
		const v2 = diagnoseUnclaim(false, [
			{ kind: "session", id: "s1", label: "repo", node: "Mac" },
			{ kind: "pin", id: "i1", label: "Heartfull", node: "Mac" },
		]);
		expect(v2.ok === false && v2.reason).toBe("pinned");
	});
});
