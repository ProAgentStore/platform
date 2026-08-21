import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IRREVERSIBLE_WRITE_TOOLS, lintAgentClaims } from "./agent-claims-lint.js";
import { CONNECTORS } from "./connectors/registry.js";

describe("lintAgentClaims (#66 — catalog description-vs-capability integrity)", () => {
	const noRuntime = { runtime: null, workflow: null };

	it("flags a deliberately-mismatched fixture (Creator OS shape)", () => {
		const v = lintAgentClaims({
			description: "Personal AI content agent: publishing through your own logged-in browser sessions via the local runner.",
			capabilities: noRuntime,
		});
		expect(v.length).toBeGreaterThan(0);
		expect(v.join(" ")).toMatch(/browser|runner|publishing/i);
	});

	it("flags a 'runs headlessly after every deploy' claim with no runtime", () => {
		expect(lintAgentClaims({ description: "Runs them headlessly after every deploy via an observable runner.", capabilities: noRuntime })).not.toHaveLength(0);
	});

	it("does NOT flag when the agent actually declares a runtime", () => {
		expect(lintAgentClaims({ description: "Runs a coding CLI on your machine via the local runner.", capabilities: { runtime: "coding", workflow: "CODING_SESSION" } })).toHaveLength(0);
	});

	it("does NOT flag a description that makes no runtime claim", () => {
		expect(lintAgentClaims({ description: "Chat with your document library; answers cite the source document.", capabilities: noRuntime })).toHaveLength(0);
	});

	it("is quiet on empty/missing input", () => {
		expect(lintAgentClaims({ description: "", capabilities: noRuntime })).toHaveLength(0);
		expect(lintAgentClaims({ description: "Browser agent", capabilities: null })).not.toHaveLength(0); // claim + no caps → flag
	});
});

/**
 * The SAFETY family (#722) — copy that promises a per-action human gate over a tool that cannot
 * be undone.
 *
 * Every string below is READ FROM THE MIGRATION rather than copied into a fixture, for the
 * reason `seed-drift.test.ts` gives: a fixture duplicating the seed tests the fixture. These
 * assertions are about text that is live in the storefront, so the text they assert on has to be
 * the live text — otherwise the test that is supposed to fail when someone re-adds the sentence
 * passes happily against its own copy of the old one.
 */
const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");
const readMigration = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");

const SQL_0134 = readMigration("0134_seed_email_assistant.sql");
const SQL_0136 = readMigration("0136_seed_inbox_chat.sql");
const SQL_0137 = readMigration("0137_inbox_chat_handles_attachments.sql");
const SQL_0138 = readMigration("0138_inbox_chat_honest_safety_copy.sql");

/** The `json('…')` config a seed INSERTs, with SQL's doubled quotes undone. */
function seededConfig(sql: string): Record<string, unknown> {
	const start = sql.indexOf("json('");
	const end = sql.indexOf("')", start);
	expect(start, "the seed no longer contains a json('…') config").toBeGreaterThan(-1);
	return JSON.parse(sql.slice(start + "json('".length, end).replace(/''/g, "'")) as Record<string, unknown>;
}

const identityOf = (sql: string) => seededConfig(sql).identity as Record<string, string>;

/** One captured group from `re`, failing loudly (not silently passing) if the shape moved. */
function capture(sql: string, re: RegExp, what: string): string {
	const m = re.exec(sql);
	expect(m, `could not find ${what} — the migration's shape changed, so this test is not reading what it claims to`).toBeTruthy();
	return (m as RegExpExecArray)[1].replace(/''/g, "'");
}

/** The description an UPDATE-style migration sets. */
const updatedDescription = (sql: string) => capture(sql, /\n\s*description = '([\s\S]*?)',\n/, "the UPDATEd description");
/** A `json_set(…, '$.identity.<field>', '…')` value. */
const updatedIdentity = (sql: string, field: string) =>
	capture(sql, new RegExp(`'\\$\\.identity\\.${field}',\\s*\\n?\\s*'([\\s\\S]*?)'\\s*\\n?\\s*\\)`), `the UPDATEd identity.${field}`);

/** Inbox Chat as it is live TODAY: 0136's welcome message, 0137's description. */
const LIVE_INBOX_DESCRIPTION = updatedDescription(SQL_0137);
const LIVE_INBOX_WELCOME = identityOf(SQL_0136).welcomeMessage;
/** Inbox Chat after this ticket. */
const FIXED_INBOX_DESCRIPTION = updatedDescription(SQL_0138);
const FIXED_INBOX_WELCOME = updatedIdentity(SQL_0138, "welcomeMessage");
const FIXED_INBOX_GOAL = updatedIdentity(SQL_0138, "goal");
/** The honest sibling (0134): the same connector, the same author, an accurate sentence. */
const EMAIL_ASSISTANT_DESCRIPTION = capture(SQL_0134, /\n\s*'(Reads an email[\s\S]*?)',\n/, "the Email Assistant description");

/** Inbox Chat's declared reach — it holds both Gmail send tools. */
const SENDS = { runtime: null, workflow: null, tools: ["gmail_search", "gmail_read_message", "gmail_reply", "gmail_send", "gmail_archive"] };
/** The same agent minus anything irreversible. */
const READS_ONLY = { runtime: null, workflow: null, tools: ["gmail_search", "gmail_read_message", "gmail_archive", "gmail_mark_read"] };

describe("lintAgentClaims — safety claims (#722)", () => {
	it("flags the live Inbox Chat description: it promises a gate nothing implements", () => {
		expect(LIVE_INBOX_DESCRIPTION).toMatch(/never sends or archives anything until you have seen/);
		const v = lintAgentClaims({ description: LIVE_INBOX_DESCRIPTION, capabilities: SENDS });
		expect(v).not.toHaveLength(0);
		expect(v.join(" ")).toMatch(/gmail_reply, gmail_send/);
	});

	it("flags the live Inbox Chat welcome message — the first thing a subscriber reads", () => {
		expect(LIVE_INBOX_WELCOME).toMatch(/show you anything before it is sent/);
		const v = lintAgentClaims({ description: "Talk to your inbox.", welcomeMessage: LIVE_INBOX_WELCOME, capabilities: SENDS });
		expect(v).not.toHaveLength(0);
		expect(v.join(" ")).toMatch(/^Welcome message promises/);
	});

	it("does NOT flag the Email Assistant description — it names a switch that exists", () => {
		// The acceptance criterion this family is designed around. "…without your explicit consent
		// switched on first" is TRUE: the per-instance connector write consent (#90) is off by
		// default and refuses the call before the handler runs. A per-action pause is not. If a
		// pattern here ever grows broad enough to catch a standing switch, it has stopped
		// distinguishing an honest claim from a false one, which is the only thing it is for.
		expect(EMAIL_ASSISTANT_DESCRIPTION).toMatch(/never sends anything without your explicit consent switched on first/);
		expect(lintAgentClaims({ description: EMAIL_ASSISTANT_DESCRIPTION, capabilities: SENDS })).toEqual([]);
	});

	it("passes the corrected Inbox Chat copy this ticket writes (0138)", () => {
		expect(lintAgentClaims({ description: FIXED_INBOX_DESCRIPTION, welcomeMessage: FIXED_INBOX_WELCOME, capabilities: SENDS })).toEqual([]);
	});

	it("the corrected copy still ANSWERS the question the false sentence was answering", () => {
		// Deleting the promise and leaving a hole would pass the lint and fail the reader: an agent
		// that reads untrusted mail has to say what stops it mailing your contacts. All three real
		// protections are named.
		expect(FIXED_INBOX_DESCRIPTION).toMatch(/email permission/i); // per-agent permission
		expect(FIXED_INBOX_DESCRIPTION).toMatch(/write access for Gmail/i); // per-instance consent (#90)
		expect(FIXED_INBOX_DESCRIPTION).toMatch(/cannot delete mail|All Mail/i); // the allowlist itself
	});

	it("stops the goal asserting an approval step the platform does not perform", () => {
		// #722: identity.goal is "not accepted as the gate". A prompt that tells the model a human
		// has approved is worse than silence — it is the only thing the old sentence rested on.
		expect(identityOf(SQL_0136).goal).toMatch(/only once they have approved/);
		expect(FIXED_INBOX_GOAL).not.toMatch(/approved/i);
		expect(FIXED_INBOX_GOAL).toMatch(/no undo|nobody reviews/i);
	});

	it("says nothing when there is nothing irreversible to gate", () => {
		// Same sentence, an agent that can only read and archive. Archiving is reversible (the
		// message stays in All Mail), so the promise costs nobody anything.
		expect(lintAgentClaims({ description: LIVE_INBOX_DESCRIPTION, welcomeMessage: LIVE_INBOX_WELCOME, capabilities: READS_ONLY })).toEqual([]);
		// And an agent that declares no allowlist at all resolves to the per-surface default,
		// which contains no connector tool — so it cannot hold a send tool it did not declare.
		expect(lintAgentClaims({ description: LIVE_INBOX_DESCRIPTION, capabilities: { runtime: null, workflow: null } })).toEqual([]);
	});

	it("does not fire on accurate sentences about the switches that exist", () => {
		for (const text of [
			"Both are off until you turn them on, and you can turn them off again at any time.",
			"It cannot send until you switch on write access for Gmail.",
			"Nothing is sent without write access switched on for this instance.",
			"You approve the connector once, in Settings.",
		]) {
			expect(lintAgentClaims({ description: text, capabilities: SENDS }), text).toEqual([]);
		}
	});

	it("catches the promise however it is phrased", () => {
		for (const text of [
			"It never posts anything until you have looked at it.",
			"It drafts the message and only once you have approved does it go out.",
			"I will show you every reply before it goes.",
			"Nothing leaves your account before it is sent to you for review.",
			"It never emails a client without your explicit approval.",
			"It asks you first before sending.",
		]) {
			expect(lintAgentClaims({ description: text, capabilities: SENDS }), text).not.toHaveLength(0);
		}
	});

	it("leaves the runtime family (#66) exactly as it was", () => {
		// Both families run; neither suppresses the other, and a safety-only agent still gets its
		// runtime verdict unchanged.
		// Two runtime families match this one sentence (browser + posting) — that is the #66
		// behaviour, unchanged; the safety family adds exactly one more.
		const runtimeClaim = "Runs a headless browser and posts on your behalf.";
		expect(lintAgentClaims({ description: runtimeClaim, capabilities: SENDS })).toHaveLength(2);
		expect(lintAgentClaims({ description: `${runtimeClaim} It never sends anything until you have approved it.`, capabilities: SENDS })).toHaveLength(3);
		// A runtime-backed agent skips the runtime family and still gets the safety one.
		const backed = { runtime: "browser", workflow: null, tools: SENDS.tools };
		expect(lintAgentClaims({ description: runtimeClaim, capabilities: backed })).toEqual([]);
		expect(lintAgentClaims({ description: LIVE_INBOX_DESCRIPTION, capabilities: backed })).not.toHaveLength(0);
	});
});

describe("IRREVERSIBLE_WRITE_TOOLS", () => {
	it("names only tools that exist, and only write-scoped ones", () => {
		// The set is hand-kept because the registry cannot answer "reversible?" yet (#722 Step 3).
		// A hand-kept set drifts silently on a rename — this is the assertion that makes it loud.
		const byName = new Map(CONNECTORS.flatMap((c) => c.tools.map((t) => [t.name, t] as const)));
		for (const name of IRREVERSIBLE_WRITE_TOOLS) {
			const tool = byName.get(name);
			expect(tool, `${name} is not a registry tool`).toBeTruthy();
			expect(tool?.scope, name).toBe("write");
		}
	});

	it("excludes the reversible Gmail actions, which is the whole distinction", () => {
		// gmail_archive's own description: "It stays in All Mail and can still be found by search,
		// so this is reversible."
		expect(IRREVERSIBLE_WRITE_TOOLS.has("gmail_archive")).toBe(false);
		expect(IRREVERSIBLE_WRITE_TOOLS.has("gmail_mark_read")).toBe(false);
		expect(IRREVERSIBLE_WRITE_TOOLS.has("gmail_send")).toBe(true);
	});
});

/**
 * A finding this ticket records rather than fixes.
 *
 * Email Assistant's DESCRIPTION is the honest example #722 holds up, and it passes. Its welcome
 * message makes the same per-action promise Inbox Chat's did — "…show you the reply before
 * anything is sent" — over the same `gmail_send`, with the same nothing behind it. It is left
 * alone deliberately: #722 is about the Inbox Chat row, and quietly narrowing this family so the
 * sentence slipped through would be tuning the rule around a row rather than judging it.
 *
 * When that copy is corrected, this test should be inverted, not deleted.
 */
describe("known, unfixed: the Email Assistant welcome message makes the same promise", () => {
	it("is flagged by the same rule", () => {
		const welcome = (seededConfig(SQL_0134).identity as Record<string, string>).welcomeMessage;
		expect(welcome).toMatch(/show you the reply before anything is sent/);
		expect(lintAgentClaims({ description: EMAIL_ASSISTANT_DESCRIPTION, welcomeMessage: welcome, capabilities: SENDS })).not.toHaveLength(0);
	});
});
