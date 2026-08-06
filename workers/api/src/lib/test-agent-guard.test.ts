import { describe, expect, it } from "vitest";
import { blockPublishReason, testAgentMarker } from "./test-agent-guard.js";

describe("testAgentMarker", () => {
	// The two that actually sat in the live public catalog (#65).
	it("catches the real offenders", () => {
		expect(testAgentMarker({ slug: "mcp-launch-smoke-202606111215", name: "MCP Launch Smoke Agent", description: "A small ProAgentStore smoke-test agent launched through MCP." })).toBeTruthy();
		expect(testAgentMarker({ slug: "codex-mcp-browser-test-20260611", name: "Codex MCP Browser Test", description: "Smoke-test agent created from Codex." })).toBeTruthy();
		expect(testAgentMarker({ slug: "google-drive-doc-chat-test", name: "Google Drive Doc Chat Test", description: "Answers questions from a folder." })).toBeTruthy();
	});

	// Whole-word matching, not substring: the obvious first instinct (`includes("test")`)
	// blocks far more real products than fixtures.
	it("does not trip on words that merely contain a marker", () => {
		for (const name of ["Latest News Digest", "Contest Judge", "Protest Tracker", "Testimonial Collector"]) {
			expect(testAgentMarker({ slug: "x", name, description: "" })).toBeNull();
		}
	});

	it("leaves the real catalog alone", () => {
		for (const a of [
			{ slug: "coder", name: "Coder", description: "Your AI coding agent for any GitHub repo." },
			{ slug: "repo-chat", name: "Repo Chat", description: "Chat with any GitHub repository." },
			{ slug: "language-buddy", name: "Language Buddy", description: "A conversation partner for learning any language." },
			{ slug: "local-repo-chat", name: "Local Repo Chat", description: "Chat with a repository on your own machine." },
		]) {
			expect(testAgentMarker(a)).toBeNull();
		}
	});

	it("reports WHICH word matched, so a refusal is actionable", () => {
		expect(testAgentMarker({ slug: "x", name: "Sandbox Runner", description: "" })).toBe("sandbox");
	});
});

describe("blockPublishReason", () => {
	const fixture = { slug: "smoke-agent", name: "Smoke Agent", description: "" };

	it("blocks publishing a fixture and names the marker", () => {
		const r = blockPublishReason(fixture, "published");
		expect(r).toContain("smoke");
		expect(r).toContain("allowTestAgent");
	});

	// Not a ban. A creator shipping something legitimately called "Test Runner" says so once.
	it("allows it with the explicit override", () => {
		expect(blockPublishReason(fixture, "published", true)).toBeNull();
	});

	// Moving AWAY from published must always work — including for an agent already published
	// that would now fail the check. Otherwise this guard would trap the very fixtures it is
	// meant to remove.
	it("never blocks unpublishing", () => {
		expect(blockPublishReason(fixture, "draft")).toBeNull();
		expect(blockPublishReason(fixture, "unlisted")).toBeNull();
		expect(blockPublishReason(fixture, undefined)).toBeNull();
	});

	it("does not block a real agent from publishing", () => {
		expect(blockPublishReason({ slug: "coder", name: "Coder", description: "Codes." }, "published")).toBeNull();
	});
});
