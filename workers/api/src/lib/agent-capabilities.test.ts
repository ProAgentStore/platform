import { describe, expect, it } from "vitest";
import { agentCapabilities, hasSurface, sanitizeSettingsSchema } from "./agent-capabilities.js";

describe("agentCapabilities", () => {
	it("uses declared config.capabilities when present", () => {
		const cfg = JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } });
		const caps = agentCapabilities({ slug: "anything", category: "x", config: cfg });
		expect(caps.surfaces).toEqual(["coding"]);
		expect(caps.runtime).toBe("coding");
		expect(caps.workflow).toBe("CODING_SESSION");
	});

	it("declared capabilities override the slug fallback", () => {
		// A 'coder'-slug agent that declares apply still resolves to apply.
		const cfg = JSON.stringify({ capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" } });
		expect(agentCapabilities({ slug: "coder", config: cfg }).surfaces).toEqual(["apply"]);
	});

	it("filters unknown surfaces out of declared config", () => {
		const cfg = JSON.stringify({ capabilities: { surfaces: ["coding", "bogus"] } });
		expect(agentCapabilities({ config: cfg }).surfaces).toEqual(["coding"]);
	});

	it("falls back to apply for the job-application agent", () => {
		const caps = agentCapabilities({ slug: "job-application-assistant" });
		expect(caps.surfaces).toEqual(["apply"]);
		expect(caps.workflow).toBe("JOB_APPLY");
	});

	it("falls back to coding for the coder slug or code category", () => {
		expect(agentCapabilities({ slug: "coder" }).surfaces).toEqual(["coding"]);
		expect(agentCapabilities({ category: "code" }).surfaces).toEqual(["coding"]);
	});

	it("is empty for a generic agent (no apply/coding UI leaks)", () => {
		const caps = agentCapabilities({ slug: "site-monitor", category: "productivity" });
		expect(caps.surfaces).toEqual([]);
		expect(caps.runtime).toBeNull();
	});

	it("tolerates malformed config", () => {
		expect(agentCapabilities({ slug: "coder", config: "{not json" }).surfaces).toEqual(["coding"]);
	});

	it("hasSurface reflects the resolved surfaces", () => {
		expect(hasSurface({ slug: "coder" }, "coding")).toBe(true);
		expect(hasSurface({ slug: "coder" }, "apply")).toBe(false);
	});

	describe("boardColumns", () => {
		const titles = (a: Parameters<typeof agentCapabilities>[0]) => agentCapabilities(a).boardColumns.map((c) => c.title);

		it("gives apply agents the hiring-pipeline columns", () => {
			const t = titles({ slug: "job-application-assistant" });
			expect(t).toContain("Applying");
			expect(t).toContain("Submitted");
			// Human-driven pipeline stages the automation never sets.
			expect(t).toEqual(expect.arrayContaining(["Interview", "Offer", "Rejected"]));
		});

		it("gives other agents the generic runtime columns (no pipeline stages)", () => {
			const t = titles({ slug: "coder" });
			expect(t).toContain("Running");
			expect(t).toContain("Done");
			expect(t).not.toContain("Interview");
		});

		it("honors declared board columns over the default", () => {
			const cfg = JSON.stringify({ capabilities: { surfaces: ["apply"], boardColumns: [{ id: "todo", title: "To do", color: "#fff", statuses: ["queued"] }] } });
			expect(titles({ config: cfg })).toEqual(["To do"]);
		});

		it("always resolves a non-empty board, even for a generic agent", () => {
			expect(agentCapabilities({ slug: "whatever" }).boardColumns.length).toBeGreaterThan(0);
		});
	});

	describe("settingsSchema", () => {
		const FIELD = {
			id: "target_language",
			label: "Target language",
			type: "select",
			voiceLanguage: true,
			default: "es-ES",
			options: [{ value: "es-ES", label: "Spanish" }, { value: "zh-CN", label: "Chinese (Mandarin)" }],
		};

		it("resolves a declared schema in the declared-capabilities path", () => {
			const cfg = JSON.stringify({ capabilities: { surfaces: [] }, settingsSchema: [FIELD] });
			const schema = agentCapabilities({ config: cfg }).settingsSchema;
			expect(schema).toHaveLength(1);
			expect(schema?.[0].id).toBe("target_language");
			expect(schema?.[0].voiceLanguage).toBe(true);
			expect(schema?.[0].default).toBe("es-ES");
		});

		it("resolves a declared schema in the slug-fallback path", () => {
			const cfg = JSON.stringify({ settingsSchema: [FIELD] });
			expect(agentCapabilities({ slug: "coder", config: cfg }).settingsSchema).toHaveLength(1);
		});

		it("drops malformed fields: bad ids, unknown types, optionless selects, invalid defaults", () => {
			const schema = sanitizeSettingsSchema([
				{ ...FIELD, id: "Bad ID!" },
				{ ...FIELD, type: "dropdown" },
				{ ...FIELD, options: [] },
				{ id: "ok", label: "Ok", type: "select", options: [{ value: "a" }], default: "not-an-option" },
				{ id: "txt", label: "Text", type: "text", default: 42 },
			]);
			expect(schema?.map((f) => f.id)).toEqual(["ok", "txt"]);
			expect(schema?.[0].default).toBeUndefined();
			expect(schema?.[0].options?.[0].label).toBe("a"); // label falls back to value
			expect(schema?.[1].default).toBeUndefined(); // wrong-typed default dropped
		});

		it("dedupes ids, caps at 12 fields and 30 options, keeps voiceLanguage only on selects", () => {
			const many = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, label: `F${i}`, type: "text" }));
			expect(sanitizeSettingsSchema(many)).toHaveLength(12);
			expect(sanitizeSettingsSchema([FIELD, FIELD])).toHaveLength(1);
			const opts = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}` }));
			expect(sanitizeSettingsSchema([{ id: "s", label: "S", type: "select", options: opts }])?.[0].options).toHaveLength(30);
			const toggle = sanitizeSettingsSchema([{ id: "t", label: "T", type: "toggle", voiceLanguage: true }]);
			expect(toggle?.[0].voiceLanguage).toBeUndefined();
		});

		it("returns undefined for absent or malformed declarations", () => {
			expect(agentCapabilities({}).settingsSchema).toBeUndefined();
			expect(sanitizeSettingsSchema("nope")).toBeUndefined();
			expect(sanitizeSettingsSchema([])).toBeUndefined();
		});
	});
});
