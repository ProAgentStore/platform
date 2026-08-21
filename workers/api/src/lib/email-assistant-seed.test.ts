import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeToolList } from "./agent-capabilities.js";
import { CREATOR_SELECTABLE_TOOLS } from "../agent-do-tools.js";

/**
 * The seeded Email Assistant (#710, migration 0134).
 *
 * Read from the migration SQL rather than from a copy, for the reason `seed-drift.test.ts`
 * gives: a fixture duplicating the seed tests the fixture. The migration is the repo's own claim
 * about the catalog and is the thing a PR can be wrong about.
 */

const SQL = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "0134_seed_email_assistant.sql"), "utf8");
const INBOX_SQL = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "0136_seed_inbox_chat.sql"), "utf8");
const INBOX_WIDEN_SQL = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "0137_inbox_chat_handles_attachments.sql"), "utf8");

/** The single json('…') literal the seed inserts as `config`. */
function seededConfig(): Record<string, unknown> {
	const start = SQL.indexOf("json('");
	const end = SQL.indexOf("')", start);
	expect(start, "the seed no longer contains a json('…') config").toBeGreaterThan(-1);
	// SQL doubles a single quote to escape it; undo that before parsing.
	return JSON.parse(SQL.slice(start + "json('".length, end).replace(/''/g, "'")) as Record<string, unknown>;
}

const capabilities = () => seededConfig().capabilities as { tools: string[]; surfaces: string[]; runtime: null; workflow: null };

describe("the seeded Email Assistant", () => {
	it("declares only tools that actually exist and are grantable", () => {
		const tools = capabilities().tools;
		// sanitizeToolList drops anything unknown, so an equal length means every name is real.
		expect(sanitizeToolList(tools)).toEqual(tools);
		for (const name of tools) expect(CREATOR_SELECTABLE_TOOLS.has(name), name).toBe(true);
	});

	it("carries the whole chain the agent's description promises", () => {
		const tools = new Set(capabilities().tools);
		// read the mail → get what was attached → fill it → send it back
		for (const name of ["gmail_search", "gmail_read_message", "gmail_download_attachment", "fill_pdf_form", "gmail_reply"]) {
			expect(tools.has(name), name).toBe(true);
		}
		// The flat-scan fallback, without which "fill the form" is a promise it cannot always keep.
		expect(tools.has("build_answer_sheet")).toBe(true);
		expect(tools.has("inspect_pdf_form")).toBe(true);
	});

	it("carries nothing it has no use for", () => {
		const tools = new Set(capabilities().tools);
		// An agent that reads untrusted mail is the last one that should hold spare reach.
		for (const name of ["send_to_cli", "read_terminal", "http_request", "add_knowledge", "delete_knowledge", "insert_record"]) {
			expect(tools.has(name), name).toBe(false);
		}
	});

	it("is cloud-only — no local runner, no workflow", () => {
		expect(capabilities()).toMatchObject({ surfaces: [], runtime: null, workflow: null });
	});

	it("cannot open either of the gates that let it actually send", () => {
		// Declaring gmail_reply grants nothing on its own: the per-agent email permission and the
		// per-instance write consent are both owner acts. If a future edit ever seeded them,
		// sending would become automatic on subscribe — which is the whole thing to prevent.
		//
		// Asserted against the STATEMENT, not the file: the header comment explains at length why
		// those gates stay out, and a blunt match on the file flagged that explanation as the
		// violation it describes.
		const statement = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
		expect(statement).not.toMatch(/permissions/i);
		expect(statement).not.toMatch(/instance_connector_consent/i);
		expect(seededConfig()).not.toHaveProperty("permissions");
		expect(seededConfig().identity).not.toHaveProperty("permissions");
	});
});

/**
 * The seeded Inbox Chat (#716, migration 0136) — the conversational sibling.
 *
 * Same reading-from-the-migration discipline. The assertions that matter are the ABSENCES: this
 * agent acts on a live mailbox, so what it cannot do is the security statement.
 */
function inboxConfig(): Record<string, unknown> {
	const start = INBOX_SQL.indexOf("json('");
	const end = INBOX_SQL.indexOf("')", start);
	return JSON.parse(INBOX_SQL.slice(start + "json('".length, end).replace(/''/g, "'")) as Record<string, unknown>;
}

/**
 * The tool list Inbox Chat ends up with — 0136's seed as amended by 0137.
 *
 * Reading only the seed would test a state the database never reaches. The amendment sets the
 * whole array, so the later one wins outright.
 */
function inboxTools(): string[] {
	const marker = "'$.capabilities.tools',";
	const at = INBOX_WIDEN_SQL.indexOf(marker);
	if (at === -1) return (inboxConfig().capabilities as { tools: string[] }).tools;
	const start = INBOX_WIDEN_SQL.indexOf("json('", at);
	const end = INBOX_WIDEN_SQL.indexOf("')", start);
	return JSON.parse(INBOX_WIDEN_SQL.slice(start + "json('".length, end)) as string[];
}

const inboxCaps = () => ({ ...(inboxConfig().capabilities as { surfaces: string[]; runtime: null; workflow: null }), tools: inboxTools() });

describe("the seeded Inbox Chat", () => {
	it("declares only tools that exist and are grantable", () => {
		const tools = inboxCaps().tools;
		expect(sanitizeToolList(tools)).toEqual(tools);
		for (const name of tools) expect(CREATOR_SELECTABLE_TOOLS.has(name), name).toBe(true);
	});

	it("carries what conversation with an inbox needs — read, reply, and the two actions", () => {
		const tools = new Set(inboxCaps().tools);
		for (const name of ["gmail_search", "gmail_read_message", "gmail_reply", "gmail_archive", "gmail_mark_read"]) {
			expect(tools.has(name), name).toBe(true);
		}
	});

	it("carries NOTHING that could destroy mail", () => {
		// gmail.modify allows trashing. No tool exposes it, and this asserts the seed cannot
		// acquire one by name either — the absence is the whole safety argument.
		const tools = inboxCaps().tools;
		expect(tools.some((t) => /delete|trash/i.test(t))).toBe(false);
	});

	// 0136 asserted the OPPOSITE: that Inbox Chat deliberately excluded the PDF tools, because
	// 0134 owned form-filling. 0137 reverses that on the evidence — two agents for one mailbox
	// meant the person who wanted an email agent had two and had to know which did what. The two
	// jobs were never unrelated: both start by reading a message someone sent you.
	it("also fills a form that arrived attached (#716, folded in by 0137)", () => {
		const tools = new Set(inboxCaps().tools);
		for (const name of ["inspect_pdf_form", "fill_pdf_form", "build_answer_sheet"]) {
			expect(tools.has(name), name).toBe(true);
		}
	});

	it("says so in its description, so the catalog does not promise less than it does", () => {
		expect(INBOX_WIDEN_SQL).toMatch(/fill in a form that arrived attached/);
	});

	it("is cloud-only, and opens none of the gates that let it act", () => {
		expect(inboxCaps()).toMatchObject({ surfaces: [], runtime: null, workflow: null });
		const statement = INBOX_SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
		expect(statement).not.toMatch(/permissions/i);
		expect(inboxConfig()).not.toHaveProperty("permissions");
	});
});
