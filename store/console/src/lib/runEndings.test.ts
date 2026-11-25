import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@proagentstore/sdk/client", () => ({ api }));

import { discardPrompt, discardRunWorktree } from "./runEndings";

const HEAD = "a".repeat(40);
beforeEach(() => api.mockReset());

describe("discardPrompt", () => {
	it("names the count, the files and what stays recoverable", () => {
		const t = discardPrompt(20, ["a.ts", "b.ts"], "refs/pags/discarded/x");
		expect(t).toMatch(/20 uncommitted files/);
		expect(t).toMatch(/and 18 more/);
		expect(t).toMatch(/refs\/pags\/discarded\/x/);
	});
});

describe("discardRunWorktree", () => {
	const sessions = { sessions: [{ id: "csess_1", repoId: "r1", runnerNode: "mac" }] };

	it("previews first, then executes with the head the preview returned, only after the owner confirms", async () => {
		api.mockResolvedValueOnce(sessions).mockResolvedValueOnce({ result: { ok: true, head: HEAD, files: 1, changed: ["x"], pinRef: "refs/pags/discarded/u" } }).mockResolvedValueOnce({ result: { ok: true, discardedFiles: 1, pinned: null } });
		const msg = await discardRunWorktree("i1", "csess_1", () => true);
		expect(msg).toMatch(/discarded \(1 file\)/);
		expect(api.mock.calls[1][0]).toBe("/v1/instances/i1/coding/repos/r1/worktrees/discard?runner_node=mac&session_id=csess_1");
		expect(JSON.parse(api.mock.calls[2][1].body)).toEqual({ runner_node: "mac", session_id: "csess_1", dry_run: false, expected_head: HEAD });
	});

	it("does nothing when the owner declines, and says so plainly when the session is unknown", async () => {
		api.mockResolvedValueOnce(sessions).mockResolvedValueOnce({ result: { ok: true, head: HEAD, files: 0, changed: [], pinRef: "r" } });
		expect(await discardRunWorktree("i1", "csess_1", () => false)).toBeNull();
		expect(api).toHaveBeenCalledTimes(2);
		api.mockReset().mockResolvedValueOnce({ sessions: [] });
		expect(await discardRunWorktree("i1", "csess_9", () => true)).toMatch(/no longer listed/);
	});
});
