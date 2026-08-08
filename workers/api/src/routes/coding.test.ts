import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The pure helpers moved to `coding-shared.ts` with the #305 split — they are what all four
// coding route modules needed, which is exactly why they are no longer in any one of them.
import { ownerOf, parseGithubRepo, pickNextIssue } from "./coding-shared.js";
// Engine presets + sign-in moved to lib/ so the workflow stops importing a routes module.
import { type CodingEngine, deriveClientType, engineAuthFor } from "../lib/coding-engines.js";
import { delegationTaskRecord } from "../lib/delegation.js";

describe("delegationTaskRecord (#155 — observable delegation task)", () => {
	const base = { id: "deleg-1", targetLabel: "pags/platform", objective: "add a health check to the api worker", now: "2026-08-03T00:00:00.000Z" };

	it("is a 'delegation' card attributed to the Overseer on the user's behalf", () => {
		const t = delegationTaskRecord({ ...base, status: "running" });
		expect(t.type).toBe("delegation");
		expect(t.status).toBe("running");
		expect(t.id).toBe("deleg-1");
		expect(String(t.title)).toMatch(/^Delegated:/);
		expect(String(t.reasoning)).toContain("Overseer delegated on your behalf");
		expect(String(t.reasoning)).toContain("pags/platform");
		// Carries the goal so the board card shows WHAT was delegated — never framed as a user turn.
		expect(String(t.reasoning)).toContain(base.objective);
	});

	it("supports the Pilot's terminal transitions (completed / failed)", () => {
		expect(delegationTaskRecord({ ...base, status: "completed" }).status).toBe("completed");
		expect(delegationTaskRecord({ ...base, status: "failed" }).status).toBe("failed");
	});

	it("truncates a long objective in the title but keeps the full goal in reasoning", () => {
		const long = "x".repeat(400);
		const t = delegationTaskRecord({ ...base, objective: long, status: "running" });
		expect(String(t.title).length).toBeLessThanOrEqual(200);
		expect(String(t.reasoning)).toContain(long.slice(0, 200)); // full objective preserved (up to the 8k cap)
	});
});

describe("pickNextIssue (issues-mode Loop objective source)", () => {
	const issues = [{ number: 7 }, { number: 3 }, { number: 12 }];
	it("picks the lowest-numbered open issue (deterministic order)", () => {
		expect(pickNextIssue(issues, new Set())).toEqual({ number: 3 });
	});
	it("skips excluded issues (declined this run + the active one)", () => {
		expect(pickNextIssue(issues, new Set([3]))).toEqual({ number: 7 });
		expect(pickNextIssue(issues, new Set([3, 7]))).toEqual({ number: 12 });
	});
	it("returns null when every issue is excluded or the backlog is empty", () => {
		expect(pickNextIssue(issues, new Set([3, 7, 12]))).toBeNull();
		expect(pickNextIssue([], new Set())).toBeNull();
	});
	it("does not mutate the input array", () => {
		const input = [{ number: 5 }, { number: 1 }];
		pickNextIssue(input, new Set());
		expect(input).toEqual([{ number: 5 }, { number: 1 }]);
	});
});

describe("parseGithubRepo (#304 — one clone-URL parser, not two)", () => {
	// The regex was written out twice: the add-repo path (a bare clone URL) and detect-github
	// (a local checkout's `origin`). These pin the shapes BOTH sites had to handle, so the one
	// remaining copy cannot be narrowed without a test going red.
	it("reads owner/repo from an https clone URL, with or without .git", () => {
		expect(parseGithubRepo("https://github.com/ProAgentStore/platform.git")).toBe("ProAgentStore/platform");
		expect(parseGithubRepo("https://github.com/ProAgentStore/platform")).toBe("ProAgentStore/platform");
	});
	it("reads an ssh remote — the shape detect-github gets back from `git remote`", () => {
		expect(parseGithubRepo("git@github.com:ProAgentStore/platform.git")).toBe("ProAgentStore/platform");
	});
	it("tolerates a trailing slash (what a browser copy-paste produces)", () => {
		expect(parseGithubRepo("https://github.com/ProAgentStore/platform/")).toBe("ProAgentStore/platform");
	});
	it("keeps dots and hyphens in both halves (org.name/repo-name.js)", () => {
		expect(parseGithubRepo("https://github.com/some-org/my.repo-name.js")).toBe("some-org/my.repo-name.js");
	});
	it("returns null for a non-GitHub host, so a GitLab remote is not mistaken for one", () => {
		expect(parseGithubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
	});
	it("returns null — not a throw — for the absent remote detect-github can receive", () => {
		// detect-github passes `remote` straight through and it is `string | null`; the old site
		// relied on `?.match`, so the helper must swallow null/undefined/empty the same way.
		expect(parseGithubRepo(null)).toBeNull();
		expect(parseGithubRepo(undefined)).toBeNull();
		expect(parseGithubRepo("")).toBeNull();
	});
});

describe("ownerOf (#304 — one owner rule, not five copies)", () => {
	it("takes the owner half of an owner/repo", () => {
		expect(ownerOf("ProAgentStore/platform")).toBe("ProAgentStore");
	});
	it("ignores extra path depth — the owner is the FIRST segment", () => {
		expect(ownerOf("owner/repo/extra")).toBe("owner");
	});
	it("returns '' for an absent ref, which callers read as 'no installation to look up'", () => {
		// The two ternary call sites guard on the result (`owner ? … : null`); returning ""
		// rather than throwing is what keeps a repo with no githubRepo from 500ing.
		expect(ownerOf(null)).toBe("");
		expect(ownerOf(undefined)).toBe("");
		expect(ownerOf("")).toBe("");
	});
	it("passes a slash-less ref through unchanged — preserved on purpose, not an oversight", () => {
		// `body.githubRepo` is accepted on trust by the add-repo route, so "platform" can be
		// stored. All five replaced sites produced "platform" here and attempted a (doomed)
		// token lookup. Returning "" instead would silently skip that lookup — a behaviour
		// change smuggled into a de-duplication. Validate at the edge instead.
		expect(ownerOf("platform")).toBe("platform");
	});
});

describe("engineAuthFor (per-engine sign-in method)", () => {
	const engines: CodingEngine[] = [
		{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions", auth: "subscription" },
		{ id: "claude-api", label: "Claude (API)", command: "claude --model opus", auth: "api-key" },
		{ id: "codex", label: "Codex", command: "codex", auth: "machine" },
		{ id: "gemini", label: "Gemini CLI", command: "gemini" },
	];

	it("matches a session's launch command back to its preset's auth", () => {
		expect(engineAuthFor(engines, "claude --dangerously-skip-permissions")).toBe("subscription");
		expect(engineAuthFor(engines, "claude --model opus")).toBe("api-key");
		expect(engineAuthFor(engines, "codex")).toBe("machine");
	});

	it("defaults to auto when the preset has no auth or the command matches nothing", () => {
		expect(engineAuthFor(engines, "gemini")).toBe("auto"); // preset without auth
		expect(engineAuthFor(engines, "claude --some-edited-command")).toBe("auto"); // edited/legacy session
		expect(engineAuthFor(engines, null)).toBe("auto");
		expect(engineAuthFor(engines, undefined)).toBe("auto");
	});

	it("ignores an invalid auth value from a hand-edited config", () => {
		const bad = [{ id: "x", label: "X", command: "claude", auth: "steal-keys" as CodingEngine["auth"] }];
		expect(engineAuthFor(bad, "claude")).toBe("auto");
	});
});

describe("deriveClientType", () => {
	it("classifies bare engine binaries", () => {
		expect(deriveClientType("claude --dangerously-skip-permissions")).toBe("claude");
		expect(deriveClientType("codex")).toBe("codex");
		expect(deriveClientType("grok --foo")).toBe("grok");
		expect(deriveClientType("gemini")).toBe("gemini");
		expect(deriveClientType("claude-code")).toBe("claude");
	});

	it("skips env assignments and launchers to find the real binary", () => {
		expect(deriveClientType("npx codex")).toBe("codex");
		expect(deriveClientType("ANTHROPIC_MODEL=x claude")).toBe("claude");
		expect(deriveClientType("env FOO=1 npx @openai/codex")).toBe("codex");
		expect(deriveClientType("bunx grok")).toBe("grok");
	});

	it("uses the basename of an absolute path", () => {
		expect(deriveClientType("/usr/local/bin/claude --resume abc")).toBe("claude");
	});

	it("treats an unknown binary as raw (codex), NOT as Claude stream-json", () => {
		expect(deriveClientType("aider --model gpt4")).toBe("codex");
		expect(deriveClientType("/opt/tools/mycli")).toBe("codex");
	});

	it("defaults to claude for an empty command", () => {
		expect(deriveClientType("")).toBe("claude");
		expect(deriveClientType("   ")).toBe("claude");
	});
});

describe("engine sign-in relay (#coding-auth)", () => {
	// The route is thin by design; what matters is the CONTRACT it enforces, so these pin the
	// decisions rather than re-testing the detector (covered in engine-auth-prompt.test.ts).

	it("only relays a URL the ENGINE printed, never one from the caller", async () => {
		// This navigates a real browser on the owner's machine. Accepting a client-supplied URL
		// would turn an authenticated route into an open redirect onto their desktop.
		const src = readFileSync(join(import.meta.dirname, "coding.ts"), "utf8");
		const route = src.slice(src.indexOf('coding/sessions/:sessionId/signin'));
		const body = route.slice(0, route.indexOf("});"));
		expect(body).toContain('callRunner<{ pane?: string }>');   // re-reads the pane
		expect(body).toContain("detectAuthPrompt");
		expect(body).not.toMatch(/req\.json\(\)[\s\S]{0,200}url/);  // never reads a URL from the request
	});

	it("hands off through the EXISTING takeover path rather than a new mechanism", async () => {
		const src = readFileSync(join(import.meta.dirname, "coding.ts"), "utf8");
		const route = src.slice(src.indexOf('coding/sessions/:sessionId/signin'));
		const body = route.slice(0, route.indexOf("});"));
		expect(body).toContain('"/browser/act"');      // navigate in the runner's browser
		// FLAT body, action as a string — the shape the runner actually parses. A nested
		// {action:{kind,url}} is accepted silently and opens nothing.
		expect(body).toContain('{ action: "navigate", url: prompt.url }');
		expect(body).toContain('"/browser/handoff"');  // same relay the apply flow uses
	});

	it("logs only the HOST of the sign-in URL, not the whole thing", () => {
		// OAuth URLs carry state/PKCE/redirect params; putting them verbatim in a durable trace
		// is a needless secret-adjacent leak.
		const src = readFileSync(join(import.meta.dirname, "coding.ts"), "utf8");
		const route = src.slice(src.indexOf('coding/sessions/:sessionId/signin'));
		const body = route.slice(0, route.indexOf("logEvent") + 400);
		expect(body).toContain("new URL(prompt.url as string).host");
	});
});

describe("terminal persistence (#coding-transcript)", () => {
	/** The capture route's body — up to the NEXT route, not the first `return c.json(`, which is
	 *  the runner-offline early return well before the code under test. */
	const routeSrc = () => {
		const src = readFileSync(join(import.meta.dirname, "coding.ts"), "utf8");
		const i = src.indexOf("coding/sessions/:sessionId/capture");
		const next = src.indexOf("codingRoutes.", i + 10);
		return src.slice(i, next === -1 ? undefined : next);
	};

	it("persists the transcript from /capture, not only from /explain", () => {
		// Before this, the ONLY writer was the Co-pilot route — so anyone working in the
		// Terminal view had nothing saved, and the pane died with the runner.
		expect(routeSrc()).toContain("appendTimeline");
		expect(routeSrc()).toContain('type: "terminal"');
	});

	it("delegates WHEN to write to the tested rule, rather than re-deciding it here", () => {
		// The gate was `runState === "idle"` inline. That optimised the case where nothing is
		// happening and failed the case where everything is: a session busy since it started never
		// reached it, so a 40-step Loop run persisted nothing at all (#432). The replacement is
		// changed + (idle OR throttled) and lives in lib/terminal-snapshot.ts, where the interval
		// and the UTC-without-a-zone timestamp parse are both tested.
		expect(routeSrc()).toContain("shouldPersistSnapshot");
		expect(routeSrc()).not.toContain('runState === "idle"');
	});

	it("dedupes against the last saved snapshot, and dates it", () => {
		// An idle session polls forever; without the dedup it would append an identical row each
		// time. The timestamp is what the throttle measures against.
		expect(routeSrc()).toContain("lastTerminalRow");
	});

	it("caps what it stores", () => {
		expect(routeSrc()).toContain("slice(-8000)");
	});
});
