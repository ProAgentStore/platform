import { describe, expect, it } from "vitest";
import { groupTerminalNodes } from "./terminals.js";

const nodeRow = (over: Partial<Parameters<typeof groupTerminalNodes>[0][number]> = {}) => ({
	instance_id: "i1", runner_node: "macbook", placement: "local", runner_version: "0.4.16",
	status: "active", last_seen_at: "2026-07-14T10:00:00Z", updated_at: "2026-07-14T10:00:00Z",
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
