import { describe, expect, it } from "vitest";
import { CONNECTORS, connectorTools, getConnector } from "./registry.js";

describe("connector registry", () => {
	it("declares every connector the platform has, including the three tool-less accounts", () => {
		const ids = CONNECTORS.map((c) => c.id).sort();
		expect(ids).toEqual([
			"browser", "github", "gmail", "google_drive", "google_sheets", "http", "mcp",
			"meta", "repo-local", "supervision", "terminal", "tmux", "web-search", "zoho_workdrive",
		]);
	});

	// #352 Stage 1. Drive/WorkDrive/Gmail already stored their refresh token in the exact row an
	// `auth:"oauth"` registry connector reads — `user_api_keys(user_id, provider=<id>)` — so
	// declaring them moved no data. These assertions pin the two properties that made it safe:
	// the ids are the ones already in live rows, and nothing gained a tool.
	describe("the three connected accounts (#352 Stage 1)", () => {
		it("keeps the ids that are already in user_api_keys and instance_connector_grants", () => {
			expect(getConnector("google_drive")?.id).toBe("google_drive");
			expect(getConnector("zoho_workdrive")?.id).toBe("zoho_workdrive");
			expect(getConnector("gmail")?.id).toBe("gmail");
		});

		it("declares no tools for the file accounts, so connectorTools() is unchanged for them", () => {
			for (const id of ["google_drive", "zoho_workdrive"]) {
				expect(getConnector(id)?.tools).toEqual([]);
			}
			expect(connectorTools().some((t) => ["google_drive", "zoho_workdrive"].includes(t.connector ?? ""))).toBe(false);
		});

		// Gmail LEFT this group in #711. The assertion is kept, inverted, rather than deleted:
		// "gmail declares no tools" was a deliberate decision, so the file should record that it
		// was deliberately reversed rather than quietly lose the line.
		it("Gmail declares tools of its own (#711 read, #713 send, #765 draft)", () => {
			expect(getConnector("gmail")?.tools.map((t) => t.name)).toEqual([
				"gmail_search",
				"gmail_read_message",
				"gmail_reply",
				"gmail_send",
				"gmail_draft_reply",
				"gmail_draft_send",
				"gmail_archive",
				"gmail_mark_read",
				"gmail_download_attachment",
			]);
			// Reading the mailbox mutates nothing; sending and drafting mutate state and say so, which
			// is what the #90 consent gate keys on.
			const byName = new Map((getConnector("gmail")?.tools ?? []).map((t) => [t.name, t]));
			for (const name of ["gmail_search", "gmail_read_message", "gmail_download_attachment"]) {
				expect(byName.get(name)?.scope, name).toBe("read");
				expect(byName.get(name)?.mutates, name).toBe(false);
			}
			for (const name of ["gmail_reply", "gmail_send", "gmail_draft_reply", "gmail_draft_send", "gmail_archive", "gmail_mark_read"]) {
				expect(byName.get(name)?.scope, name).toBe("write");
				expect(byName.get(name)?.mutates, name).toBe(true);
			}
		});

		it("keeps the file connectors read-only — there is no write path in drive.ts/workdrive.ts", () => {
			for (const id of ["google_drive", "zoho_workdrive"]) {
				expect(getConnector(id)?.scopes).toEqual({ read: true, write: false });
			}
			// Gmail left this group in #713: it can send, so it declares write and is consent-gated.
			expect(getConnector("gmail")?.scopes).toEqual({ read: true, write: true });
		});

		it("models Drive/WorkDrive reach as instance-resource and Gmail's as user", () => {
			expect(getConnector("google_drive")?.grantModel).toBe("instance-resource");
			expect(getConnector("zoho_workdrive")?.grantModel).toBe("instance-resource");
			// Gmail has no grant row; its reach is the per-agent permissions.email flag, which the
			// registry has no model for — see connected-accounts.ts for why it is not invented here.
			expect(getConnector("gmail")?.grantModel).toBe("user");
		});

		it("declares WorkDrive with NO oauth block — its endpoints are per data-centre", () => {
			// Not an omission: `workDriveAccountsBase(env)` is env-dependent, so there is no static
			// authorize URL to declare. Omitting it keeps the generic OAuth route 404ing for this id
			// instead of building a URL against the wrong DC.
			expect(getConnector("zoho_workdrive")?.oauth).toBeUndefined();
			expect(getConnector("google_drive")?.oauth?.tokenUrl).toBe("https://oauth2.googleapis.com/token");
		});
	});

	// repo-local is the only read-ONLY connector: scopes.write:false is what makes it
	// impossible to write-consent, which is the whole reason it isn't part of tmux.
	it("repo-local is a no-auth local connector with no write scope", () => {
		const repo = getConnector("repo-local");
		expect(repo?.auth).toBe("none");
		expect(repo?.scopes).toEqual({ read: true, write: false });
		const tools = connectorTools().filter((t) => t.connector === "repo-local");
		// Six since #508 added repo_find and repo_grep — the connector had four read tools and not
		// one of them searched. The invariant that matters is the NEXT line: a connector whose
		// `scopes.write` is false can never be write-consented, so the count growing must never
		// grow the privilege.
		expect(tools.length).toBe(6);
		expect(tools.every((t) => t.scope === "read")).toBe(true);
	});

	it("browser is a no-auth local connector (relay-reached, like tmux), read+write", () => {
		const browser = getConnector("browser");
		expect(browser?.auth).toBe("none");
		expect(browser?.scopes).toEqual({ read: true, write: true });
		expect(browser?.grantModel).toBe("user");
		expect(browser?.tools.map((t) => t.name).sort()).toEqual(["browser_act", "browser_navigate", "browser_snapshot"]);
	});

	it("web-search is a token-auth, read-only, user-grant connector with no tokenEnv (vault-backed)", () => {
		const ws = getConnector("web-search");
		expect(ws?.auth).toBe("token");
		expect(ws?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault key
		expect(ws?.scopes).toEqual({ read: true, write: false });
		expect(ws?.grantModel).toBe("user");
		expect(ws?.tools.map((t) => t.name)).toEqual(["web_search"]);
	});

	it("http is a token-auth, read+write, user-grant connector with no tokenEnv (vault-backed)", () => {
		const http = getConnector("http");
		expect(http?.auth).toBe("token");
		expect(http?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault key
		expect(http?.scopes).toEqual({ read: true, write: true });
		expect(http?.grantModel).toBe("user");
		expect(http?.tools.map((t) => t.name)).toEqual(["http_request"]);
	});

	it("mcp is a token-auth, read+write, user-grant connector with no tokenEnv (vault-backed)", () => {
		const mcp = getConnector("mcp");
		expect(mcp?.auth).toBe("token");
		expect(mcp?.tokenEnv).toBeUndefined(); // no platform env → connectorClient reads the vault token
		expect(mcp?.scopes).toEqual({ read: true, write: true });
		expect(mcp?.grantModel).toBe("user");
		// Six, not two (#263): the read side — resources and prompts — is part of this connector, and
	// a server whose context an agent can only guess at is the failure the connector exists to fix.
	expect(mcp?.tools.map((t) => t.name)).toEqual([
		"mcp_list_tools",
		"mcp_call_tool",
		"mcp_list_resources",
		"mcp_read_resource",
		"mcp_list_prompts",
		"mcp_get_prompt",
	]);
	});

	it("mcp_call_tool is write-scoped (a remote tool call can mutate) while discovery is read", () => {
		const byName = new Map(connectorTools().map((t) => [t.name, t] as const));
		expect(byName.get("mcp_call_tool")?.scope).toBe("write");
		expect(byName.get("mcp_list_tools")?.scope).toBe("read");
	});

	it("the mcp connector hardcodes no server host — the endpoint is a tool input", () => {
		// Store independence: a host baked in here would make some other service a runtime
		// dependency of this Worker. The server must come from config/user data instead.
		const mcp = getConnector("mcp");
		const declared = JSON.stringify(mcp?.tools.map((t) => ({ d: t.description, s: t.jsonSchema })));
		expect(declared).not.toMatch(/https:\/\/(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i);
		expect(mcp?.tools.every((t) => t.jsonSchema.required?.includes("url"))).toBe(true);
	});

	it("github is an app-auth, read+write, user-grant connector", () => {
		const gh = getConnector("github");
		expect(gh?.auth).toBe("app");
		expect(gh?.scopes).toEqual({ read: true, write: true });
		expect(gh?.grantModel).toBe("user");
	});

	it("meta is a token-auth connector backed by META_ACCESS_TOKEN (write-only)", () => {
		const meta = getConnector("meta");
		expect(meta?.auth).toBe("token");
		expect(meta?.tokenEnv).toBe("META_ACCESS_TOKEN");
		expect(meta?.scopes).toEqual({ read: false, write: true });
	});

	it("tmux is a no-auth local connector", () => {
		expect(getConnector("tmux")?.auth).toBe("none");
	});

	it("terminal is a no-auth local connector with read+write runner tools", () => {
		const terminal = getConnector("terminal");
		expect(terminal?.auth).toBe("none");
		expect(terminal?.scopes).toEqual({ read: true, write: true });
		expect(terminal?.grantModel).toBe("user");
		expect(terminal?.tools.map((t) => t.name).sort()).toEqual([
			"terminal_capture",
			"terminal_kill_target",
			"terminal_list_targets",
			"terminal_new_target",
			"terminal_run_command",
			"terminal_send_keys",
			"terminal_send_message",
		]);
	});

	it("unknown connector → undefined", () => {
		expect(getConnector("nope")).toBeUndefined();
	});

	it("connectorTools flattens every connector's tools and stamps connector/tier/scope", () => {
		const tools = connectorTools();
		// Every connector's tools are present.
		const byConnector = new Map<string, number>();
		for (const t of tools) {
			expect(t.tier).toBe("connector");
			expect(typeof t.connector).toBe("string");
			expect(t.scope === "read" || t.scope === "write").toBe(true);
			byConnector.set(t.connector as string, (byConnector.get(t.connector as string) ?? 0) + 1);
		}
		expect(byConnector.get("github")).toBeGreaterThan(0);
		expect(byConnector.get("meta")).toBeGreaterThan(0);
		expect(byConnector.get("tmux")).toBeGreaterThan(0);
	});

	it("the flattened tool set matches the sum of each connector's tools", () => {
		const declared = CONNECTORS.reduce((n, c) => n + c.tools.length, 0);
		expect(connectorTools().length).toBe(declared);
	});

	// ── What granting WRITE means, declared per connector (#720) ────────────────────────────
	//
	// The write-consent panel rendered ONE paragraph over every checkbox — "act as you, click,
	// type and navigate, through the connector on your machine" — which is exact for `browser`
	// and false in every clause for `github`. Measured live on 2026-08-21 across the operator
	// account's 43 instances: the panel rendered on 32, 27 of those showed a checkbox for a
	// connector that is not on the owner's machine, and `browser` rendered on none of them.
	//
	// It survived seven connectors arriving because NOTHING ASSERTED ANYTHING ABOUT IT. That is
	// what this test is: the decay guard, not a spelling check. Every clause below was measured
	// against the connector's own write handlers, and the two the proposed wording got wrong were
	// corrected there rather than here — `github` writes under the App installation and not "as
	// you", and `meta` sends from the platform's business account and not the owner's.
	describe("writeMeaning — a grant the owner cannot evaluate is not consent", () => {
		const writable = CONNECTORS.filter((c) => c.scopes.write === true);

		it("has one for EVERY write-capable connector — the assertion the shared paragraph never had", () => {
			// The denominator, so "all present" over an empty set can never pass as a tick.
			expect(writable.length).toBeGreaterThanOrEqual(9);
			const missing = writable.filter((c) => !c.writeMeaning || c.writeMeaning.trim().length < 20).map((c) => c.id);
			expect(
				missing,
				`${missing.join(", ")} can be write-granted with nothing to say what that permits. Declare \`writeMeaning\` on the connector — do NOT add a special case in ToolPermissions.tsx.`,
			).toEqual([]);
		});

		it("says nothing about a connector that cannot be write-granted", () => {
			// A meaning on a read-only connector would render nowhere and rot unread. `repo-local`
			// is read-only ON PURPOSE (a read-only connector can never be write-consented), and
			// that decision is worth not blurring.
			for (const c of CONNECTORS.filter((x) => !x.scopes.write)) expect(c.writeMeaning, c.id).toBeUndefined();
		});

		it("keeps the MCP kill-switch sentence, which is the one that grants no reach on its own", () => {
			// It lived in a hardcoded `connectors.includes("mcp")` branch in the console until #720.
			// Moved verbatim: an owner who loses it reads a ticked `mcp` box as a full grant, when
			// #262 grants reach per server AND per remote tool.
			expect(getConnector("mcp")?.writeMeaning).toBe(
				"MCP write access is a kill switch, not a permission: the agent still can’t call anything until you name a server and tool below.",
			);
		});

		it("does not describe a browser for a connector that has none", () => {
			// The defect, stated as an assertion. `browser` is the only connector these words are
			// true of, so it is the only one allowed to use them.
			for (const c of writable.filter((x) => x.id !== "browser")) {
				expect(c.writeMeaning, c.id).not.toMatch(/\bclick\b/i);
				expect(c.writeMeaning, c.id).not.toMatch(/\bnavigate\b/i);
			}
			expect(getConnector("browser")?.writeMeaning).toMatch(/click, type and navigate/i);
		});

		it("only claims 'on your own computer' for the connectors that are", () => {
			// The other half of the same false sentence: `github`, `mcp`, `supervision` and `http`
			// are cloud or platform-internal, and 27 of 32 panels were telling owners otherwise.
			const local = new Set(["terminal", "tmux", "browser"]);
			for (const c of writable) {
				const claimsLocal = /your own computer|your machine/i.test(c.writeMeaning ?? "");
				expect(claimsLocal, `${c.id} ${claimsLocal ? "claims" : "does not claim"} to run on the owner's machine`).toBe(local.has(c.id));
			}
		});
	});
});
