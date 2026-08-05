import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccountPreferences } from "./preferences.js";

// Migration 0071 is EXECUTED here against real SQLite, not text-matched.
//
// It earns that because two bugs in it were only findable by running it:
//   1. promoting from "the newest instance with voiceSettings" silently orphaned the translation of
//      a user who had translation on one agent and voice on another (or on none);
//   2. json_object()/json_set()/json() around a scalar subquery embeds the value as an ESCAPED
//      STRING — SQLite's JSON subtype does not survive the subquery — so every promoted preference
//      would have failed parseAccountPreferences' typeof check and reverted to platform defaults.
//
// Both look completely correct when read. A grep-style assertion would have shipped them.
const MIGRATION = join(__dirname, "../../migrations/0071_account_preferences.sql");

function runMigration(seed: string): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, board_config TEXT NOT NULL DEFAULT '');
		CREATE TABLE agent_instances (id TEXT PRIMARY KEY, user_id TEXT, config TEXT, updated_at TEXT);
	`);
	db.exec(seed);
	db.exec(readFileSync(MIGRATION, "utf8"));
	return db;
}

const prefsOf = (db: DatabaseSync, id: string): string =>
	String((db.prepare("SELECT preferences FROM users WHERE id = ?").get(id) as { preferences: string }).preferences);

const configOf = (db: DatabaseSync, id: string): Record<string, unknown> =>
	JSON.parse(String((db.prepare("SELECT config FROM agent_instances WHERE id = ?").get(id) as { config: string }).config));

describe("migration 0071 — promoting per-agent preferences to the account", () => {
	const seed = `
		INSERT INTO users VALUES ('u1',''),('u2',''),('u3',''),('u4','');
		INSERT INTO agent_instances VALUES
		 ('a','u1','{"displayName":"old","voiceSettings":{"speed":90},"translation":{"target":"French"}}','2026-07-01'),
		 ('b','u1','{"displayName":"new","voiceSettings":{"speed":130,"sttMode":"openai"},"translation":{"target":"Chinese"}}','2026-08-04'),
		 ('c','u2','{"translation":{"target":"German"}}','2026-08-01'),
		 ('d','u3','{not json','2026-08-01'),
		 ('e','u4','{"displayName":"plain"}','2026-08-01');
	`;

	it("promotes the NEWEST instance's values", () => {
		const db = runMigration(seed);
		const p = parseAccountPreferences(prefsOf(db, "u1"));
		expect(p.voice?.speed).toBe(130);
		expect(p.voice?.sttMode).toBe("openai");
		expect(p.translation?.target).toBe("Chinese");
	});

	it("writes REAL nested JSON, not an escaped string", () => {
		// The bug that would have made the whole migration a no-op while looking like it worked:
		// json_extract returns TEXT and the JSON subtype is lost across a scalar subquery, so
		// json_object() produces {"voice":"{\\"speed\\":130}"} — a string, which
		// parseAccountPreferences rejects, silently reverting every user to platform defaults.
		const db = runMigration(seed);
		const raw = JSON.parse(prefsOf(db, "u1")) as Record<string, unknown>;
		expect(typeof raw.voice).toBe("object");
		expect(typeof raw.translation).toBe("object");
	});

	it("promotes voice and translation INDEPENDENTLY", () => {
		// u2 has translation but no voiceSettings. Keying the promotion off voiceSettings alone
		// left this user's translation renamed to *Legacy with nothing promoted — silent loss.
		const db = runMigration(seed);
		const p = parseAccountPreferences(prefsOf(db, "u2"));
		expect(p.translation?.target).toBe("German");
		expect(p.voice).toBeUndefined();
	});

	it("clears every per-instance copy — presence is the override flag", () => {
		// Load-bearing: `config.voiceSettings` present means "customised for this agent". Leaving
		// the old copies would make every existing agent read as customised on day one, which is
		// the per-agent sprawl this change removes.
		const db = runMigration(seed);
		for (const id of ["a", "b", "c"]) {
			const cfg = configOf(db, id);
			expect(cfg.voiceSettings, id).toBeUndefined();
			expect(cfg.translation, id).toBeUndefined();
		}
	});

	it("keeps the old values recoverable under *Legacy", () => {
		// The promotion picks ONE instance; if it picked wrong, the rest must not be gone.
		const db = runMigration(seed);
		expect(configOf(db, "a").voiceSettingsLegacy).toEqual({ speed: 90 });
		expect(configOf(db, "a").translationLegacy).toEqual({ target: "French" });
	});

	it("preserves unrelated config keys", () => {
		const db = runMigration(seed);
		expect(configOf(db, "b").displayName).toBe("new");
		expect(configOf(db, "e").displayName).toBe("plain");
	});

	it("leaves a user with nothing to promote empty, not '{}'", () => {
		// An empty blob means "never configured", which is what lets the platform defaults apply.
		const db = runMigration(seed);
		expect(prefsOf(db, "u4")).toBe("");
		expect(parseAccountPreferences(prefsOf(db, "u4"))).toEqual({});
	});

	it("survives a malformed instance config without failing the whole migration", () => {
		// One corrupt row must not block every other user's promotion — a migration that throws
		// halfway leaves the database in exactly the split state this is trying to avoid.
		const db = runMigration(seed);
		expect(prefsOf(db, "u3")).toBe("");
		expect(configOf(db, "b").voiceSettingsLegacy).toBeDefined(); // u1 still promoted fine
	});

	it("is idempotent — a re-run must not clobber a promoted account with nothing", () => {
		// D1 will not re-run an applied migration, but a hand-run during recovery is exactly when
		// clobbering would hurt most. The `preferences = ''` guard is what prevents it.
		const db = runMigration(seed);
		const before = prefsOf(db, "u1");
		// Re-apply only the data statements (the ALTER would fail on a duplicate column).
		const sql = readFileSync(MIGRATION, "utf8").split("\n").filter((l) => !l.startsWith("ALTER TABLE users")).join("\n");
		db.exec(sql);
		expect(prefsOf(db, "u1")).toBe(before);
	});
});
