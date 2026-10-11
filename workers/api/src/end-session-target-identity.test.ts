/**
 * `end_coding_session`'s target is the OWNER's, exactly as written (#1015) — the identity matrices.
 *
 * Split out of agent-think-control-intent.test.ts, which keeps the consent/authorship cases through the real
 * `runAgentThink`. These need only the real registry handler on the migrated schema, and at ~240 cases
 * they would otherwise hold one worker for over a minute. Fixture text only — never a live control call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./lib/d1-sqlite.js";
import { getRegistryTool } from "./lib/tool-registry.js";
import type { Env } from "./types.js";

// The migrated schema is built ONCE; every test starts from empty tables and a freshly seeded tenant —
// the same isolation as a new database, without replaying every migration for each of ~330 cases.
let d1: RealSchemaD1;
let env: Env;
beforeAll(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
});
beforeEach(() => {
	const tables = d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all() as Array<{ name: string }>;
	d1.sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const { name } of tables) d1.sqlite.exec(`DELETE FROM "${name}"`);
	d1.sqlite.exec("PRAGMA foreign_keys = ON");
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterAll(() => d1.close());

// ── #1015 follow-up: identity-bearing suffixes, ambiguous exclusions, post-session labels ──────────────
//
// Writer-level: every session row's status is read after each call. "Zero writes" means every row is
// exactly as seeded. Each case below names whether the previous source wrote to the wrong target.

describe("session identity is exact: suffixes, shared names in exclusions, and labels after 'session' (#1015)", () => {
	const seedRepo = (repoId: string, name: string) => d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
	const seedSession = (id: string, repoId: string, name: string) => {
		seedRepo(repoId, name);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const statuses = () => (d1.sqlite.prepare("SELECT id, status FROM coding_sessions ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`);
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);

	// ── 1. A trailing "-", "/" or ".." is part of the name. Previously stripped → the name read as a known
	//       repo, nothing matched, and the request fell back to the one open session: WRONG-TARGET WRITES. ──
	const SUFFIXED = ["platform-", "platform/", "owner1/platform-", "owner1/platform/"];
	const QUOTES: Array<[string, (x: string) => string]> = [
		["plain", (x) => x],
		["backtick", (x) => `\`${x}\``],
		["double-quoted", (x) => `"${x}"`],
	];
	const POSITIONS: Array<[string, (x: string) => string]> = [
		["X session", (x) => `Please close the ${x} session.`],
		["session for X", (x) => `Please close the session for ${x}.`],
		["session named X", (x) => `Please close the session named ${x}.`],
	];
	const SELECTORS: Array<Record<string, unknown>> = [{}, { repo: "aipa" }];
	const suffixCases = SUFFIXED.flatMap((name) => QUOTES.flatMap(([q, quote]) => POSITIONS.flatMap(([p, phrase]) => SELECTORS.map((sel) => [`${phrase(quote(name))} [${q}, ${p}, selector ${JSON.stringify(sel)}]`, phrase(quote(name)), sel] as const))));
	it.each(suffixCases)("%s — zero writes", async (_label, text, sel) => {
		seedRepo("r1", "platform");
		seedRepo("r3", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end(text, sel);
		expect(statuses()).toEqual(["s2:active"]);
	});

	// ── 2. A short name two repositories share, in an EXCLUSION, excludes both. Previously it excluded
	//       neither, so the one open platform session was ended: WRONG-TARGET WRITES (A, B, C). ──
	it.each([
		["A: only owner1/platform open", ["owner1"], "Close every session except platform."],
		["B: only owner1/platform open", ["owner1"], "Please close the session, not platform."],
		["C: only owner2/platform open", ["owner2"], "Close every session except platform."],
		["D: both open", ["owner1", "owner2"], "Close every session except platform."],
	])("%s — '%s' — zero writes", async (_label, open, text) => {
		seedRepo("r1", "owner1/platform");
		seedRepo("r2", "owner2/platform");
		if (open.includes("owner1")) seedSession("s1", "r1", "owner1/platform");
		if (open.includes("owner2")) seedSession("s2", "r2", "owner2/platform");
		const before = statuses();
		await end(text as string);
		expect(statuses()).toEqual(before);
	});

	// ── 3. A label directly after "session" is a target. Previously the bare form was invisible and the
	//       one open session was ended: WRONG-TARGET WRITES for the two unquoted "session ghost" cases. ──
	it.each([
		["Please close the session ghost.", {}],
		["Please close the session ghost.", { repo: "aipa" }],
		["Please close the session `ghost`.", {}],
		["Please close the session `ghost`.", { repo: "aipa" }],
		["Please close the session other/platform.", {}],
		["Please close the session other/platform.", { repo: "aipa" }],
		["Please close session `ghost`.", {}],
		["Please close session `ghost`.", { repo: "aipa" }],
	])("'%s' (selector %j) — zero writes", async (text, sel) => {
		seedRepo("r3", "other/platform");
		seedSession("s2", "r2", "aipa");
		await end(text, sel);
		expect(statuses()).toEqual(["s2:active"]);
	});

	// ── controls ──
	it("a generic close still ends the one open session", async () => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the session.");
		expect(statuses()).toEqual(["s2:ended"]);
	});

	it("'close the session for aipa.' — the sentence's period — ends aipa", async () => {
		seedSession("s2", "r2", "aipa");
		await end("Please close the session for aipa.");
		expect(statuses()).toEqual(["s2:ended"]);
	});

	it("'close the session aipa.' — a known label directly after 'session' — ends aipa", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the session aipa.");
		expect(statuses()).toEqual(["s1:active", "s2:ended"]);
	});

	it("'Close every session except aipa.' with aipa and owner1/platform open ends owner1/platform only", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Close every session except aipa.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});
});

// ── #1015 audit of e173c97d: an explicit slot keeps its identity — quotes, labels, leading characters ──
//
// Fixture text only. A name in an explicit slot is literal: generic vocabulary inside a quoted or named
// target is that name, punctuation inside quotes is part of it, a leading "-", "." or "/" is part of it,
// and a target-bearing slot that cannot be read stays unresolved. Writer-level, every session row checked.

describe("explicit target slots keep their literal identity (#1015 audit of e173c97d)", () => {
	const seedRepo = (repoId: string, name: string) => d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('${repoId}', 'i1', 'u1', '${name}')`);
	const seedSession = (id: string, repoId: string, name: string) => {
		seedRepo(repoId, name);
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, client_type, status) VALUES ('${id}', 'i1', '${repoId}', 'u1', 'claude', 'active')`);
	};
	const statuses = () => (d1.sqlite.prepare("SELECT id, status FROM coding_sessions ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => `${r.id}:${r.status}`);
	const cancels = () => (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_loop_runs WHERE cancel_requested = 1").get() as { n: number }).n;
	const end = async (text: string, input: Record<string, unknown> = {}) =>
		getRegistryTool("end_coding_session")?.handler({ env, instanceId: "i1", userId: "u1", turn: { author: "owner", text } } as never, input);
	const SELECTORS: Array<Record<string, unknown>> = [{}, { repo: "aipa" }];
	const QUOTED: Array<[string, (x: string) => string]> = [
		["plain", (x) => x],
		["backtick", (x) => `\`${x}\``],
		["double-quoted", (x) => `"${x}"`],
		["curly-quoted", (x) => `“${x}”`],
	];
	/** Only aipa is open, and a run drives it — so a wrong end is visible twice: a status and a cancel. */
	const onlyAipaDriven = () => {
		seedRepo("r1", "platform");
		seedRepo("r3", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-aipa', 'u1', 'i1', 'synthetic', 'running', 10, ${Date.now()}, 's2')`);
	};
	const zeroWrites = () => {
		expect(statuses()).toEqual(["s2:active"]);
		expect(cancels()).toBe(0);
	};

	// Generic vocabulary inside an explicitly LABELLED target is that label, not "the session".
	const labelCases = ["named", "called", "titled"].flatMap((lead) =>
		["coding", "current", "repo"].flatMap((word) => QUOTED.flatMap(([q, quote]) => SELECTORS.map((sel) => [`session ${lead} ${quote(word)} [${q}, ${JSON.stringify(sel)}]`, `Please close the session ${lead} ${quote(word)}.`, sel] as const))),
	);
	it.each(labelCases)("%s — zero writes", async (_l, text, sel) => {
		onlyAipaDriven();
		await end(text, sel);
		zeroWrites();
	});

	// A QUOTED word in any slot is literal — even a generic one.
	const quotedGeneric = ["`coding`", '"coding"', "“current”"].flatMap((w) =>
		[(x: string) => `Please close the ${x} session.`, (x: string) => `Please close the session for ${x}.`, (x: string) => `Please close the session ${x}.`].flatMap((phrase) => SELECTORS.map((sel) => [phrase(w), sel] as const)),
	);
	it.each(quotedGeneric)("'%s' (selector %j) — a quoted generic word is a literal name: zero writes", async (text, sel) => {
		onlyAipaDriven();
		await end(text, sel);
		zeroWrites();
	});

	// A leading "-", "." or "/" is part of the name.
	const leading = ["-platform", ".platform", "/platform", "-owner1/platform"].flatMap((name) =>
		QUOTED.flatMap(([q, quote]) =>
			[(x: string) => `Please close the ${x} session.`, (x: string) => `Please close the session for ${x}.`, (x: string) => `Please close the session named ${x}.`].flatMap((phrase) =>
				SELECTORS.map((sel) => [`${phrase(quote(name))} [${q}, ${JSON.stringify(sel)}]`, phrase(quote(name)), sel] as const),
			),
		),
	);
	it.each(leading)("%s — zero writes", async (_l, text, sel) => {
		onlyAipaDriven();
		await end(text, sel);
		zeroWrites();
	});

	// Punctuation INSIDE quotes is literal: a quoted "owner1/platform." is not owner1/platform.
	const quotedPunct = ['"owner1/platform."', "`owner1/platform.`", "“owner1/platform.”", '"owner1/platform,"'].flatMap((w) =>
		[(x: string) => `Please close the ${x} session.`, (x: string) => `Please close the session for ${x}.`, (x: string) => `Please close the session named ${x}.`].flatMap((phrase) =>
			[{}, { repo: "owner1/platform" }].map((sel) => [phrase(w), sel] as const),
		),
	);
	it.each(quotedPunct)("'%s' (selector %j) — quoted punctuation is part of the name: zero writes", async (text, sel) => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end(text, sel);
		expect(statuses()).toEqual(["s1:active", "s2:active"]);
	});

	// A target-bearing slot that cannot be read is unresolved, never generic.
	it.each(SELECTORS.flatMap((sel) => ["Please close the session named.", 'Please close the session named "', "Please close the session called ``.", 'Please close the "" session.'].map((t) => [t, sel] as const)))("'%s' (selector %j) — an unreadable target slot: zero writes", async (text, sel) => {
		onlyAipaDriven();
		await end(text, sel);
		zeroWrites();
	});

	// The exclusion side of the same invariant: a dotted, quoted or bare name in "except …" keeps its whole
	// identity — the sentence's period is not the name's. Inherited residual: all 12 ended owner1/platform.v1.
	const dottedExclusions = ["owner1/platform.v1", "platform.v1"].flatMap((name) =>
		[
			["plain", (x: string) => x],
			["double-quoted", (x: string) => `"${x}"`],
			["backtick", (x: string) => `\`${x}\``],
		].flatMap(([q, quote]) => [{}, { repo: "owner1/platform.v1" }].map((sel) => [`except ${(quote as (x: string) => string)(name)} [${q}, ${JSON.stringify(sel)}]`, `Close every session except ${(quote as (x: string) => string)(name)}.`, sel] as const)),
	);
	it.each(dottedExclusions)("%s — the excluded dotted repository is never ended: zero writes", async (_l, text, sel) => {
		seedRepo("r1", "owner1/platform.v1");
		seedRepo("r2", "owner2/platform.v1");
		seedRepo("r3", "aipa");
		seedSession("s1", "r1", "owner1/platform.v1");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-v1', 'u1', 'i1', 'synthetic', 'running', 10, ${Date.now()}, 's1')`);
		await end(text, sel);
		expect(statuses()).toEqual(["s1:active"]);
		expect(cancels()).toBe(0);
	});

	// ── success controls ──
	it("unquoted sentence punctuation is the sentence's: 'session for owner1/platform.' ends owner1/platform", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Please close the session for owner1/platform.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});

	it.each(["Please close the coding session.", "Please close the current session.", "Please close the session.", "Please close the session now."])("'%s' — an unquoted generic phrase still ends the one open session", async (text) => {
		seedSession("s2", "r2", "aipa");
		await end(text);
		expect(statuses()).toEqual(["s2:ended"]);
	});

	it.each(["Please close the `aipa` session.", 'Please close the session named "aipa".', "Please close the session called aipa.", "Please close the session titled `aipa`."])("'%s' — a quoted or labelled real name still ends it", async (text) => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end(text);
		expect(statuses()).toEqual(["s1:active", "s2:ended"]);
	});

	it("'Close every session except aipa.' still ends the rest", async () => {
		seedSession("s1", "r1", "owner1/platform");
		seedSession("s2", "r2", "aipa");
		await end("Close every session except aipa.");
		expect(statuses()).toEqual(["s1:ended", "s2:active"]);
	});
});
