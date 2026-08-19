import { describe, expect, it } from "vitest";
import { allToolPolicyInputs, resolveToolPolicy } from "./instance-tool-policy.js";
import { CONNECTOR_REACH, connectorIds, declaredReachOf, TOOL_REACH, TOOL_REACHES, reachOf } from "./tool-reach.js";
import { BASE, toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

/**
 * Does the listing tell an auditor the truth about what a tool can REACH (#584)?
 *
 * ── The claim that was false ────────────────────────────────────────────────────────────────
 *
 * Measured on the deployed API over all 34 instances of the operator account (2026-08-15), the
 * console told TEN of them "…but has no tool that reaches outside the platform" while `fetch_url`
 * was `allowed:true` on every one. It derived that from "does any listed tool name a connector",
 * which #525 falsified when it put the connector-less built-ins on the same listing.
 *
 * The listing now carries `reach` so the sentence has a field that answers it. This file is what
 * keeps that field honest, and it is deliberately shaped like `tool-mutation-report.test.ts`: the
 * outward set is WRITTEN OUT rather than derived, because deriving it would assert the code agrees
 * with itself. A tool arriving here or leaving fails this test BY NAME, which is what makes
 * someone read the handler and decide.
 *
 * ── ADR 0002: what this file measured ───────────────────────────────────────────────────────
 *
 * Every arm states its denominator and fails when the input is implausibly small. The floors sit
 * below the live counts with a reason, never at them — this surface grows.
 *
 * ── G4: watched fail ────────────────────────────────────────────────────────────────────────
 *
 * Reverting `reach: reachOf(t)` in `resolveToolPolicy` to the pre-#584 proxy (`t.connector ?
 * "internet" : "platform"`) turns `fetch_url`, `send_to_cli`, `submit_job_application`,
 * `find_confirmation_link`, `http_reachable`, `geocode`, `fan_out`, `enrich` and `ai_generate`
 * red in "classifies every row", and `supervision` red in "a connector is not the question".
 */

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/**
 * Every tool in the listing that can reach the owner's own MACHINE — the runner relay, and
 * nothing beyond it.
 */
const MACHINE = new Set<string>([
	// built-ins
	"read_terminal",
	"send_to_cli",
	// first-party registry
	"end_coding_session",
	// terminal connector
	"terminal_list_targets",
	"terminal_capture",
	"terminal_run_command",
	"terminal_send_keys",
	"terminal_send_message",
	"terminal_new_target",
	"terminal_kill_target",
	// tmux connector
	"tmux_list_sessions",
	"tmux_capture_pane",
	"tmux_run_command",
	"tmux_send_keys",
	"tmux_send_message",
	"tmux_new_session",
	"tmux_kill_session",
	// repo-local connector — reads the checkout on the machine; nothing is copied to the platform
	"repo_tree",
	"repo_read_file",
	"repo_git",
	"repo_find",
	"repo_grep",
	"repo_remote",
]);

/**
 * Every tool in the listing that can reach a THIRD-PARTY system.
 *
 * The nine connector-less ones at the top are #584's finding: none of them is visible to a
 * predicate that asks "does this name a connector", and every one of them leaves the platform.
 */
const INTERNET = new Set<string>([
	// ── connector-less, and therefore invisible to the old proxy ──
	"fetch_url", // the caller picks method, body and host — the ten instances in #584
	"submit_job_application", // posts a form on a third-party ATS as the owner
	"find_confirmation_link", // reads the owner's connected Gmail
	"http_reachable", // GETs a URL the caller names; mutates:false and still outside
	"geocode", // POSTs to Google Places from a fixed template
	"fan_out", // forwards the author's whole request — method included — to http_request
	"enrich", // dispatches whatever tool name it is handed
	"ai_generate", // sends the prompt to the model provider
	// ── github ──
	"github_workflow_runs",
	"github_list_issues",
	"github_read_issue",
	"github_list_pulls",
	"github_read_pull",
	"github_create_issue",
	"github_comment_issue",
	"github_update_issue",
	// ── meta ──
	"whatsapp_send_message",
	"instagram_send_dm",
	// ── browser: on the machine, but driven to any site the caller names ──
	"browser_navigate",
	"browser_snapshot",
	"browser_act",
	// ── http / mcp / search / sheets ──
	"http_request",
	"mcp_list_tools",
	"mcp_call_tool",
	"mcp_list_resources",
	"mcp_read_resource",
	"mcp_list_prompts",
	"mcp_get_prompt",
	"web_search",
	"sheets_read",
	"sheets_append",
	// ── gmail (#711): the owner's mailbox is Google's, wherever the result ends up ──
	"gmail_search",
	"gmail_read_message",
	"gmail_download_attachment",
]);

describe("the listing reports what a tool can reach (#584)", () => {
	it("classifies every row, and the outward set is the audited one", () => {
		const rows = resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []);
		// G1/G2 — the denominator, asserted and printed. 104 rows were measured in production;
		// below 90 means a connector or the built-in catalog failed to load and this file would be
		// grading a fraction of the surface.
		expect(rows.length, "the tool listing collapsed — this test is measuring a fraction of it").toBeGreaterThan(90);
		const machine = rows.filter((r) => r.reach === "machine").map((r) => r.name).sort();
		const internet = rows.filter((r) => r.reach === "internet").map((r) => r.name).sort();
		expect(machine, "a tool changed its reach: read its handler and update MACHINE with the reason").toEqual([...MACHINE].sort());
		expect(internet, "a tool changed its reach: read its handler and update INTERNET with the reason").toEqual([...INTERNET].sort());
		const platform = rows.length - machine.length - internet.length;
		console.log(`✓ #584: ${rows.length} rows — ${platform} platform, ${machine.length} machine, ${internet.length} internet`);
	});

	it("classifies every row by DECLARATION, never by the closed default", () => {
		// The default is `internet`, which is safe for the claim and useless as an answer: it would
		// tell an owner that `write_memory` reaches the internet. G3 — a row the tables cannot
		// classify is reported, not skipped.
		const inputs = allToolPolicyInputs();
		expect(inputs.length, "the tool listing collapsed").toBeGreaterThan(90);
		const undeclared = inputs.filter((t) => declaredReachOf(t) === null).map((t) => t.name);
		expect(undeclared, "these tools reach the listing with no declared reach — classify them in tool-reach.ts").toEqual([]);
		// …and every connector, including the three that ship with no tools yet.
		const ids = connectorIds();
		expect(ids.length, "the connector registry collapsed").toBeGreaterThan(10);
		expect(ids.filter((id) => !CONNECTOR_REACH[id]), "these connectors have no declared reach").toEqual([]);
		console.log(`✓ #584: ${inputs.length} tools + ${ids.length} connectors all declare a reach`);
	});

	it("keeps both tables free of names the listing does not have", () => {
		// A stale entry is not harmless: it reads as a classification of a tool that no longer
		// exists, and it hides the shadowing of one that does.
		const names = new Set(allToolPolicyInputs().map((t) => t.name));
		expect(Object.keys(TOOL_REACH).filter((n) => !names.has(n)), "TOOL_REACH names a tool the listing does not have").toEqual([]);
		const connectors = new Set(connectorIds());
		expect(Object.keys(CONNECTOR_REACH).filter((c) => !connectors.has(c)), "CONNECTOR_REACH names a connector that is gone").toEqual([]);
		for (const r of Object.values(TOOL_REACH)) expect(TOOL_REACHES).toContain(r);
		for (const r of Object.values(CONNECTOR_REACH)) expect(TOOL_REACHES).toContain(r);
	});

	it("answers #584 by name — the three tools the acceptance criterion lists", () => {
		const by = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []).map((r) => [r.name, r]));
		for (const name of ["fetch_url", "send_to_cli", "submit_job_application"]) {
			const row = by.get(name);
			expect(row?.reach, `${name} reaches outside the platform and must report it`).not.toBe("platform");
			// …and is invisible to the predicate the console used to ask instead.
			expect(row?.connector, `${name} has no connector — which is why "names a connector" could not answer this`).toBeUndefined();
		}
	});

	it("a connector is not the question — supervision names one and never leaves", () => {
		// The other direction of the same error. If reach were re-derived from `connector`, these
		// six would be reported as external access to a system that does not exist.
		const by = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []).map((r) => [r.name, r]));
		for (const name of ["list_subordinates", "subordinate_status", "delegate_goal", "check_delegation", "transfer_conversation", "set_direction"]) {
			expect(by.get(name)?.connector, `${name} must still be a supervision tool`).toBe("supervision");
			expect(by.get(name)?.reach, `${name} is one owner's two instances — it does not leave the platform`).toBe("platform");
		}
	});

	it("is orthogonal to scope, mutates and tier — the three fields it was mistaken for", () => {
		const by = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs(), []).map((r) => [r.name, r]));
		// tier: `fetch_url` and `write_memory` are the SAME tier and opposite reaches.
		expect(by.get("fetch_url")?.tier).toBe(by.get("write_memory")?.tier);
		expect(by.get("fetch_url")?.reach).toBe("internet");
		expect(by.get("write_memory")?.reach).toBe("platform");
		// mutates: `http_reachable` changes nothing and still leaves.
		expect(by.get("http_reachable")?.mutates).toBe(false);
		expect(by.get("http_reachable")?.reach).toBe("internet");
		// scope: `write_memory` is the write that stays home; `web_search` the read that does not.
		expect(by.get("write_memory")?.scope).toBe("write");
		expect(by.get("web_search")?.scope).toBe("read");
		expect(by.get("web_search")?.reach).toBe("internet");
	});
});

/**
 * The invariant #577 AC4 asks to be declared where it is relied on — recorded as a MEASUREMENT
 * rather than a comment, because a comment cannot notice when it stops being true.
 *
 * Nothing depends on it any more: since #584 the console's sentences are derived from `mutates`
 * and `reach`, so an agent that somehow held no platform write would be described correctly rather
 * than by accident. What the invariant explains is why the other two sentences are UNREACHABLE in
 * production, which is worth knowing before someone hunts for the live instance that renders one:
 *
 *   • `BASE` is seeded into EVERY branch of `toolNamesFor` — declared-allowlist, repo, coding and
 *     FULL — so a `capabilities.tools` allowlist cannot remove any of it. `repo-chat` declares
 *     exactly three tools and still lists all of BASE.
 *   • BASE contains six connector-less platform writes (`write_memory`, `delete_memory`,
 *     `create_task`, `update_task`, `configure_board`, `set_user_preference`) — so the read-only
 *     sentence cannot render — AND `fetch_url`, whose reach is the internet — so the "changes only
 *     its own data" sentence cannot render either. Both were 0 of 34 in the enumeration.
 *   • The owner's off-switch does not change it: the console lists `allowed || disabled`, so a
 *     tool switched off is still one of this agent's tools and still counted.
 */
describe("why the own-data and read-only sentences are unreachable in production (#577)", () => {
	/** The six of #577's comment. Named individually so removing ONE fails by name, not silently. */
	const PLATFORM_WRITES = ["write_memory", "delete_memory", "create_task", "update_task", "configure_board", "set_user_preference"] as const;

	/** Every capability shape `toolNamesFor` branches on. G1: each branch, not a favourite. */
	const shapes: Array<[string, AgentCapabilities]> = [
		["declares nothing (FULL)", caps({})],
		["declares an allowlist (repo-chat's three)", caps({ tools: ["search_knowledge", "list_knowledge", "read_knowledge"] })],
		["repo surface", caps({ surfaces: ["repo"] })],
		["coding surface", caps({ surfaces: ["coding"] })],
		["coding surface, drive:false", caps({ surfaces: ["coding"], surfaceOptions: { coding: { drive: false } } } as Partial<AgentCapabilities>)],
	];

	it("every capability shape holds all six platform writes AND fetch_url", () => {
		expect(BASE.length, "BASE collapsed — this measures nothing").toBeGreaterThan(15);
		for (const [label, c] of shapes) {
			const names = toolNamesFor(c);
			expect(names.size, `${label}: no tools resolved`).toBeGreaterThan(10);
			for (const w of PLATFORM_WRITES) {
				expect(names.has(w), `${label} lost ${w} — the read-only sentence is now reachable, and it had better be true`).toBe(true);
				expect(reachOf({ name: w }), `${w} must stay a platform write for this argument to hold`).toBe("platform");
			}
			expect(names.has("fetch_url"), `${label} lost fetch_url — the own-data sentence is now reachable`).toBe(true);
			expect(reachOf({ name: "fetch_url" })).toBe("internet");
		}
		console.log(`✓ #577: ${shapes.length} capability shapes, all holding the 6 platform writes + fetch_url from BASE`);
	});
});
