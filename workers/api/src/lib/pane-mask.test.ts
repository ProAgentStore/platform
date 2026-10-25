/**
 * #1195 — the platform masks terminal text itself: at every point it takes a pane in or writes one down, so a runner older than 0.4.158
 * (which answers with the pane as it is) and rows stored before this change stop being a way to read a credential.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskSecrets } from "../../../../packages/cli/src/crash-reports.js";
import { appendTimeline } from "./coding-timeline.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { redactPane } from "./engine-reauth.js";
import { maskConnectorResult, maskPaneText } from "./pane-mask.js";
import { recordTerminalSnapshot, recordTerminalToolUse } from "./terminal-record.js";
import type { Env } from "../types.js";

const PAGS_SESSION = `${Buffer.from(JSON.stringify({ uid: "github:serge-ivo", roles: ["user"], iat: 1, exp: 2 })).toString("base64url")}.${"x".repeat(43)}`;
const CORPUS = [
	"npm run build && git status",
	"$ export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234",
	`Authorization: Bearer abcdefgh12345678`,
	`session printed by a tool: ${PAGS_SESSION}`,
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
	"ghp_abcdefghijklmnopqrstuvwx and github_pat_11ABCDEFG0123456789_abcdefghij",
	"xoxb-1234567890-abcdefghijk",
	"password: hunter2hunter2\napi_key=ABCD1234efgh\nsecret = 'not-quoted-by-pattern'",
	"pags_runner_0123456789abcdef",
	"Basic dXNlcjpwYXNzd29yZA==",
	"a long ordinary line of build output with token counts: 1234 tokens used",
	"",
];

describe("the platform's redactor is the runner's", () => {
	it("masks exactly what maskSecrets masks, over the same corpus", () => {
		for (const text of CORPUS) expect(maskPaneText(text), JSON.stringify(text)).toBe(maskSecrets(text));
	});
	it("is idempotent: masking masked text changes nothing", () => {
		for (const text of CORPUS) expect(maskPaneText(maskPaneText(text))).toBe(maskPaneText(text));
	});
	it("catches the shapes that matter and leaves ordinary output alone", () => {
		expect(maskPaneText(`x ${PAGS_SESSION} y`)).toBe("x [redacted-jwt] y");
		expect(maskPaneText("export KEY=sk-ant-oat01-abcdefghijklmnop")).not.toContain("sk-ant");
		expect(maskPaneText("npm run build")).toBe("npm run build");
		expect(maskPaneText("")).toBe("");
	});
});

describe("a connector result is masked only for the terminal connectors", () => {
	it("tmux and terminal: content masked, everything else kept; other connectors untouched", () => {
		const r = { success: true, content: `$ cat .env\nTOKEN=${"a".repeat(20)}\nBearer abcdefgh12345678` };
		for (const c of ["tmux", "terminal"]) {
			const m = maskConnectorResult(c, r);
			expect(m.success).toBe(true);
			expect(m.content).not.toContain("a".repeat(20));
			expect(m.content).not.toContain("abcdefgh12345678");
		}
		expect(maskConnectorResult("github", r)).toBe(r);
		expect(maskConnectorResult(undefined, r)).toBe(r);
	});
});

describe("what the platform writes down is masked on the way in", () => {
	let d1: RealSchemaD1;
	let env: Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'app')`);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('s1', 'i1', 'r1', 'u1', 'claude', 'active')`);
		env = { DB: d1.DB } as unknown as Env;
	});
	afterEach(() => d1.close());
	const secret = `ghp_${"A".repeat(30)}`;

	it("the coding timeline: terminal snapshots and typed commands are masked, narrative rows are the owner's words and are not", async () => {
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "terminal", content: `$ echo ${secret}` });
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "command", content: `curl -H "Authorization: Bearer abcdefgh12345678"` });
		await appendTimeline(env, { sessionId: "s1", instanceId: "i1", userId: "u1", type: "system", content: `note ${secret}` });
		const rows = d1.sqlite.prepare("SELECT type, content FROM coding_timeline ORDER BY seq").all() as Array<{ type: string; content: string }>;
		expect(rows[0].content).toBe("$ echo [redacted]");
		expect(rows[1].content).not.toContain("abcdefgh12345678");
		expect(rows[2].content).toContain(secret); // not a pane
	});
	it("the terminal record: a stored snapshot and a typed command are masked, and so is a capture a tool returned", async () => {
		await recordTerminalSnapshot(env, { instanceId: "i1", userId: "u1", target: "tmux:shell", pane: `$ echo ${secret}\n$ `, settled: true });
		await recordTerminalToolUse(env, { instanceId: "i1", userId: "u1", name: "tmux_run_command", input: { session: "shell", command: `export T=${secret}` }, success: true, content: `$ export T=${secret}` });
		const rows = d1.sqlite.prepare("SELECT type, content FROM terminal_history").all() as Array<{ type: string; content: string }>;
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const r of rows) expect(r.content, r.type).not.toContain(secret);
	});
	it("the sign-in relay's pane view masks too, on top of the Anthropic token rule", () => {
		expect(redactPane(`Your token: sk-ant-oat01-${"Z".repeat(40)}\npassword: hunter2hunter2`)).not.toMatch(/Z{10}|hunter2hunter2/);
	});
});
