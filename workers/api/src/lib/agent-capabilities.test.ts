import { describe, expect, it } from "vitest";
import { agentCapabilities, hasSurface, sanitizeDeclaredCapabilities, sanitizeSettingsSchema, sanitizeToolList, sanitizeCustomSurfaces } from "./agent-capabilities.js";

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

	describe("declared tool allowlist", () => {
		it("resolves config.capabilities.tools onto the capabilities", () => {
			const cfg = JSON.stringify({ capabilities: { surfaces: ["repo"], tools: ["search_knowledge", "read_knowledge"] } });
			expect(agentCapabilities({ config: cfg }).tools).toEqual(["search_knowledge", "read_knowledge"]);
		});

		it("resolves tools even when no surfaces are declared (fallback path)", () => {
			const cfg = JSON.stringify({ capabilities: { tools: ["upload_file"] } });
			expect(agentCapabilities({ slug: "generic", config: cfg }).tools).toEqual(["upload_file"]);
		});

		it("is undefined when no tools are declared", () => {
			expect(agentCapabilities({ slug: "coder" }).tools).toBeUndefined();
			expect(agentCapabilities({ config: JSON.stringify({ capabilities: { surfaces: ["coding"] } }) }).tools).toBeUndefined();
		});

		it("sanitizeToolList dedupes, caps at 40, and drops junk", () => {
			expect(sanitizeToolList(["read_memory", "read_memory", "fetch_url"])).toEqual(["read_memory", "fetch_url"]);
			expect(sanitizeToolList(["search_knowledge", 3, null, "Bad Name", "-x"])).toEqual(["search_knowledge"]);
			expect(sanitizeToolList(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(40);
			expect(sanitizeToolList("nope")).toBeUndefined();
			expect(sanitizeToolList([])).toBeUndefined();
			expect(sanitizeToolList([1, 2, 3])).toBeUndefined();
		});
	});

	describe("sanitizeDeclaredCapabilities (#141 authoring path)", () => {
		it("passes through valid closed-enum fields", () => {
			expect(
				sanitizeDeclaredCapabilities({
					surfaces: ["coding"],
					runtime: "coding",
					workflow: "CODING_SESSION",
					tools: ["list_coding_repos", "read_terminal"],
				}),
			).toEqual({
				surfaces: ["coding"],
				runtime: "coding",
				workflow: "CODING_SESSION",
				tools: ["list_coding_repos", "read_terminal"],
			});
		});

		it("drops unknown surfaces and dedupes", () => {
			expect(sanitizeDeclaredCapabilities({ surfaces: ["coding", "bogus", "coding", "repo"] }).surfaces).toEqual([
				"coding",
				"repo",
			]);
		});

		it("coerces an unknown runtime/workflow to null (but keeps the key when present)", () => {
			expect(sanitizeDeclaredCapabilities({ runtime: "gpu", workflow: "DO_EVERYTHING" })).toEqual({
				runtime: null,
				workflow: null,
			});
			expect(sanitizeDeclaredCapabilities({ runtime: null, workflow: null })).toEqual({
				runtime: null,
				workflow: null,
			});
		});

		it("only includes keys that were provided (clean partial PATCH)", () => {
			expect(sanitizeDeclaredCapabilities({ surfaces: ["repo"] })).toEqual({ surfaces: ["repo"] });
			expect(sanitizeDeclaredCapabilities({})).toEqual({});
			expect(sanitizeDeclaredCapabilities(null)).toEqual({});
			expect(sanitizeDeclaredCapabilities("nope")).toEqual({});
		});

		it("honors an empty tools array as an explicit clear", () => {
			expect(sanitizeDeclaredCapabilities({ tools: [] })).toEqual({ tools: [] });
			expect(sanitizeDeclaredCapabilities({ tools: ["Bad Name", 3] })).toEqual({ tools: [] });
		});

		it("round-trips through agentCapabilities to a working Coder-equivalent", () => {
			const declared = sanitizeDeclaredCapabilities({
				surfaces: ["coding"],
				runtime: "coding",
				workflow: "CODING_SESSION",
			});
			const caps = agentCapabilities({ slug: "my-clone", config: JSON.stringify({ capabilities: declared }) });
			expect(caps.surfaces).toEqual(["coding"]);
			expect(caps.runtime).toBe("coding");
			expect(caps.workflow).toBe("CODING_SESSION");
		});
	});
});

describe("custom surfaces — a bundle must not be able to impersonate a built-in tab", () => {
	const surf = (over: Record<string, unknown> = {}) => ({
		id: "notes", label: "Notes", bundleUrl: "https://example.com/s.js", ...over,
	});

	it("REJECTS a surface claiming a built-in id", () => {
		// The console resolves custom surfaces BEFORE the built-in registry, so `{id:"settings"}`
		// would render a third-party bundle where the real Settings tab belongs — a
		// credential-phishing surface under a legitimate label.
		for (const id of ["settings", "chat", "board", "coding", "knowledge", "apply"]) {
			expect(sanitizeCustomSurfaces([surf({ id })])).toBeUndefined();
		}
	});

	it("rejects a reserved id regardless of case or padding", () => {
		expect(sanitizeCustomSurfaces([surf({ id: " SETTINGS " })])).toBeUndefined();
	});

	it("drops duplicate ids — they also produced duplicate React keys", () => {
		const out = sanitizeCustomSurfaces([surf({ id: "notes" }), surf({ id: "notes", label: "Other" })]);
		expect(out).toHaveLength(1);
		expect(out?.[0].label).toBe("Notes");
	});

	it("enforces an id charset instead of accepting any non-empty string", () => {
		for (const id of ["../evil", "a b", "Notes!", "", "-leading", "9start"]) {
			expect(sanitizeCustomSurfaces([surf({ id })])).toBeUndefined();
		}
		expect(sanitizeCustomSurfaces([surf({ id: "my-notes2" })])).toHaveLength(1);
	});

	it("caps the count and the field lengths", () => {
		// Sibling validators cap (settings 12, tools 40); this one capped nothing, so an owner
		// could persist thousands of megabyte-labelled surfaces into every instance response.
		const many = Array.from({ length: 50 }, (_, i) => surf({ id: `s${i}` }));
		expect(sanitizeCustomSurfaces(many)?.length).toBeLessThanOrEqual(8);
		const long = sanitizeCustomSurfaces([surf({ label: "x".repeat(5000), icon: "y".repeat(500) })]);
		expect(long?.[0].label.length).toBe(80);
		expect((long?.[0].icon ?? "").length).toBeLessThanOrEqual(8);
	});

	it("still requires an https bundle URL", () => {
		for (const u of ["http://x/s.js", "javascript:alert(1)", "//x/s.js", ""]) {
			expect(sanitizeCustomSurfaces([surf({ bundleUrl: u })])).toBeUndefined();
		}
	});

	it("accepts a well-formed surface", () => {
		expect(sanitizeCustomSurfaces([surf()])).toEqual([
			{ id: "notes", label: "Notes", bundleUrl: "https://example.com/s.js", icon: undefined },
		]);
	});
});
