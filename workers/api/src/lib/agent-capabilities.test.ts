import { describe, expect, it } from "vitest";
import { agentCapabilities, columnForStatus, connectorConstraintsForInstance, customSurfacesEnabled, hasSurface, sanitizeDeclaredCapabilities, sanitizeSettingsSchema, sanitizeToolList, sanitizeCustomSurfaces } from "./agent-capabilities.js";
import { constraintsFor, optionsFor } from "./surface-options.js";

/** Custom surfaces are fail-closed (#186); the shape rules only run once a platform enables them. */
const ON = { CUSTOM_SURFACES_ENABLED: "1" };

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
		const cfg = JSON.stringify({ capabilities: { surfaces: ["coding", "tmux", "bogus"] } });
		expect(agentCapabilities({ config: cfg }).surfaces).toEqual(["coding", "tmux"]);
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

	it("derives nothing for the insurance slug/category — its workflow never existed (#375)", () => {
		// The branch resolved `workflow: "INSURANCE_QUOTES"`, which no `[[workflows]]` binding
		// backed, plus a surface the console registry renders no tab for. That is a runtime claim
		// with nothing behind it: `lintAgentClaims` read the agent as runtime-backed and stopped
		// warning about copy nothing could deliver.
		for (const agent of [{ slug: "like4like-insurance-quotes" }, { category: "insurance" }]) {
			const caps = agentCapabilities(agent);
			expect(caps.surfaces, JSON.stringify(agent)).toEqual([]);
			expect(caps.workflow).toBeNull();
			expect(caps.runtime).toBeNull();
		}
	});

	it("drops a STORED workflow the platform does not run, on read", () => {
		// Rows persisted while the enum was wider must not keep resolving to a brain nothing
		// starts — the write-side sanitizer only fixes an agent on its next save.
		const cfg = JSON.stringify({ capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "INSURANCE_QUOTES" } });
		expect(agentCapabilities({ config: cfg }).workflow).toBeNull();
		const ok = JSON.stringify({ capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } });
		expect(agentCapabilities({ config: ok }).workflow).toBe("BROWSER_TASK");
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
			expect(sanitizeDeclaredCapabilities({ surfaces: ["coding", "bogus", "coding", "repo", "tmux"] }).surfaces).toEqual([
				"coding",
				"repo",
				"tmux",
			]);
		});

		it("coerces an unknown runtime/workflow to null (but keeps the key when present)", () => {
			expect(sanitizeDeclaredCapabilities({ runtime: "gpu", workflow: "DO_EVERYTHING" })).toEqual({
				runtime: null,
				workflow: null,
			});
			// Including the one that used to be accepted here while nothing ran it (#375).
			expect(sanitizeDeclaredCapabilities({ workflow: "INSURANCE_QUOTES" })).toEqual({ workflow: null });
			// …and the one the console's picker never offered, which is the whole point.
			expect(sanitizeDeclaredCapabilities({ workflow: "BROWSER_TASK" })).toEqual({ workflow: "BROWSER_TASK" });
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

describe("customSurfacesEnabled — the feature is OFF unless a platform operator says otherwise", () => {
	// #186: a surface bundle is third-party CODE in the console origin holding the viewer's
	// session, and the platform serves NO bundles (workers/host answers every /console/* with the
	// HTML shell), so the feature could not be used legitimately while remaining a code-execution
	// path. Fail-closed, same shape as browserToolsEnabled (#103).
	it('is on only for exactly "1" or "true"', () => {
		expect(customSurfacesEnabled({ CUSTOM_SURFACES_ENABLED: "1" })).toBe(true);
		expect(customSurfacesEnabled({ CUSTOM_SURFACES_ENABLED: "true" })).toBe(true);
	});

	it("fails closed for absent, empty, or unrecognised values", () => {
		for (const v of [undefined, "", "0", "false", "yes", "TRUE", "on"]) {
			expect(customSurfacesEnabled({ CUSTOM_SURFACES_ENABLED: v }), String(v)).toBe(false);
		}
		expect(customSurfacesEnabled()).toBe(false);
		expect(customSurfacesEnabled(null)).toBe(false);
		expect(customSurfacesEnabled({})).toBe(false);
	});

	it("drops every declared surface when the gate is off, however well-formed", () => {
		const perfect = [{ id: "notes", label: "Notes", bundleUrl: "https://proagentstore.online/s.js" }];
		expect(sanitizeCustomSurfaces(perfect)).toBeUndefined();
		expect(sanitizeCustomSurfaces(perfect, {})).toBeUndefined();
		expect(sanitizeCustomSurfaces(perfect, { CUSTOM_SURFACES_ENABLED: "0" })).toBeUndefined();
		expect(sanitizeCustomSurfaces(perfect, ON)).toHaveLength(1);
	});

	it("resolves no customSurfaces off a stored config while the gate is off", () => {
		// The read/serve path (agentCapabilities → /v1/instances/my/instances) is what the console
		// renders tabs from, so a row persisted while the flag was on must not keep rendering.
		const agent = { slug: "x", config: JSON.stringify({ capabilities: { surfaces: [], customSurfaces: [{ id: "notes", label: "Notes", bundleUrl: "https://proagentstore.online/s.js" }] } }) };
		expect(agentCapabilities(agent).customSurfaces).toBeUndefined();
		expect(agentCapabilities(agent, ON)?.customSurfaces).toHaveLength(1);
	});

	it("leaves every OTHER capability untouched when the gate is off", () => {
		// The gate must switch off one feature, not degrade capability resolution.
		const agent = { slug: "x", config: JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } }) };
		expect(agentCapabilities(agent)).toMatchObject({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" });
	});
});

describe("custom surfaces — a bundle must not be able to impersonate a built-in tab", () => {
	// Bundles must live on a platform host (see isAllowedBundleUrl) — a surface runs as code
	// in the console origin, so the fixture uses a real allowed host. Every call passes the
	// enabled env: these assert the SHAPE rules, which only run once the gate is open.
	const surf = (over: Record<string, unknown> = {}) => ({
		id: "notes", label: "Notes", bundleUrl: "https://proagentstore.online/s.js", ...over,
	});

	it("REJECTS a surface claiming a built-in id", () => {
		// The console resolves custom surfaces BEFORE the built-in registry, so `{id:"settings"}`
		// would render a third-party bundle where the real Settings tab belongs — a
		// credential-phishing surface under a legitimate label.
		for (const id of ["settings", "chat", "board", "coding", "tmux", "knowledge", "apply"]) {
			expect(sanitizeCustomSurfaces([surf({ id })], ON)).toBeUndefined();
		}
	});

	it("rejects a reserved id regardless of case or padding", () => {
		expect(sanitizeCustomSurfaces([surf({ id: " SETTINGS " })], ON)).toBeUndefined();
	});

	it("drops duplicate ids — they also produced duplicate React keys", () => {
		const out = sanitizeCustomSurfaces([surf({ id: "notes" }), surf({ id: "notes", label: "Other" })], ON);
		expect(out).toHaveLength(1);
		expect(out?.[0].label).toBe("Notes");
	});

	it("enforces an id charset instead of accepting any non-empty string", () => {
		for (const id of ["../evil", "a b", "Notes!", "", "-leading", "9start"]) {
			expect(sanitizeCustomSurfaces([surf({ id })], ON)).toBeUndefined();
		}
		expect(sanitizeCustomSurfaces([surf({ id: "my-notes2" })], ON)).toHaveLength(1);
	});

	it("caps the count and the field lengths", () => {
		// Sibling validators cap (settings 12, tools 40); this one capped nothing, so an owner
		// could persist thousands of megabyte-labelled surfaces into every instance response.
		const many = Array.from({ length: 50 }, (_, i) => surf({ id: `s${i}` }));
		expect(sanitizeCustomSurfaces(many, ON)?.length).toBeLessThanOrEqual(8);
		const long = sanitizeCustomSurfaces([surf({ label: "x".repeat(5000), icon: "y".repeat(500) })], ON);
		expect(long?.[0].label.length).toBe(80);
		expect((long?.[0].icon ?? "").length).toBeLessThanOrEqual(8);
	});

	it("still requires an https bundle URL", () => {
		for (const u of ["http://proagentstore.online/s.js", "javascript:alert(1)", "//x/s.js", ""]) {
			expect(sanitizeCustomSurfaces([surf({ bundleUrl: u })], ON)).toBeUndefined();
		}
	});

	it("REJECTS a cross-origin bundle server-side, not just in the console", () => {
		// A bundle executes as code in the console origin with the viewer's session. The console
		// refused cross-origin, but the server persisted and served it — so any second consumer
		// (mobile shell, SSR/preview, admin preview) that mounted a bundle without re-doing that
		// check inherited account takeover.
		for (const u of ["https://evil.example/x.js", "https://proagentstore.online.evil.com/x.js"]) {
			expect(sanitizeCustomSurfaces([surf({ bundleUrl: u })], ON)).toBeUndefined();
		}
	});

	it("accepts a bundle on the platform's own hosts", () => {
		expect(sanitizeCustomSurfaces([surf({ bundleUrl: "https://proagentstore.online/s.js" })], ON)).toHaveLength(1);
		expect(sanitizeCustomSurfaces([surf({ bundleUrl: "https://cdn.proagentstore.online/s.js" })], ON)).toHaveLength(1);
	});

	it("accepts the ROOT-RELATIVE form the docs actually document", () => {
		// The docs, the AgentDetail editor's help text and the shipped example all use
		// `/console/surfaces/*.js`; the absolute-only check silently dropped every one of them.
		expect(sanitizeCustomSurfaces([surf({ bundleUrl: "/console/surfaces/notes.js" })], ON)).toHaveLength(1);
		expect(sanitizeCustomSurfaces([surf({ bundleUrl: "//evil.example/notes.js" })], ON)).toBeUndefined();
	});
});

describe("agentCapabilities — surfaceOptions must SURVIVE resolution", () => {
	const declared = (caps: Record<string, unknown>) => ({ slug: "x", category: "code", config: JSON.stringify({ capabilities: caps }) });

	it("returns the declared per-surface options", () => {
		// They were validated and PERSISTED, but neither return path copied them onto the resolved
		// capabilities — so every consumer read `undefined` and `optionsFor()` fell back to
		// SURFACE_DEFAULTS. A supervised Repo Coder declaring `{drive:false, repos:"single"}` still
		// got send_to_cli/read_terminal (the third drive-path #154 removes) and still rendered
		// add-repo plus a multi-repo list it cannot use. The existing tests pass because they build
		// the capabilities literal by hand and never go through this function.
		const caps = agentCapabilities(declared({ surfaces: ["coding"], surfaceOptions: { coding: { drive: false, repos: "single" } } }));
		expect(caps.surfaceOptions).toEqual({ coding: { drive: false, repos: "single" } });
	});

	it("gates the option on the surface, so it can never switch one on", () => {
		const caps = agentCapabilities(declared({ surfaces: ["coding"], surfaceOptions: { coding: { drive: false } } }));
		expect(optionsFor(caps, "coding")).toMatchObject({ drive: false });
		expect(optionsFor(caps, "apply")).toBeNull();
	});

	it("omits the key entirely when nothing non-default is declared", () => {
		// Keeps a stored config readable and means adding this feature rewrote nothing.
		expect(agentCapabilities(declared({ surfaces: ["coding"] })).surfaceOptions).toBeUndefined();
	});

	it("carries options through the FALLBACK derivation too (a legacy agent can still declare them)", () => {
		const caps = agentCapabilities({ slug: "coder", category: "code", config: JSON.stringify({ capabilities: { surfaceOptions: { coding: { repos: "single" } } } }) });
		expect(caps.surfaces).toContain("coding"); // derived, not declared
		expect(caps.surfaceOptions).toEqual({ coding: { repos: "single" } });
	});
});

describe("capability constraints — declared, sanitised, persisted, resolved (#404)", () => {
	const declared = (caps: Record<string, unknown>) => ({ slug: "x", category: "chat", config: JSON.stringify({ capabilities: caps }) });

	it("a creator's declaration survives the authoring route's sanitiser", () => {
		expect(sanitizeDeclaredCapabilities({ surfaces: ["tmux"], surfaceOptions: { terminal: { backends: ["tmux"] } } })).toEqual({
			surfaces: ["tmux"],
			surfaceOptions: { terminal: { backends: ["tmux"] } },
		});
	});

	it("the sanitiser enforces the CLOSED vocabulary — no new connector, no new field, no new value", () => {
		// One validator for the whole map is the argument for extending surfaceOptions rather than
		// adding a sibling: a write cannot reach config by a path that skips it.
		expect(sanitizeDeclaredCapabilities({ surfaceOptions: { terminal: { backends: ["ssh", "screen"] } } })).toEqual({});
		expect(sanitizeDeclaredCapabilities({ surfaceOptions: { terminal: { domains: ["evil.example"] } } })).toEqual({});
		expect(sanitizeDeclaredCapabilities({ surfaceOptions: { github: { backends: ["tmux"] } } })).toEqual({});
		expect(sanitizeDeclaredCapabilities({ surfaceOptions: { terminal: { backends: ["tmux", "ssh"] } } })).toEqual({
			surfaceOptions: { terminal: { backends: ["tmux"] } },
		});
	});

	it("resolves back off the stored config, without needing the connector to be a declared surface", () => {
		const caps = agentCapabilities(declared({ surfaces: [], surfaceOptions: { terminal: { backends: ["tmux"] } } }));
		expect(constraintsFor(caps, "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("an agent that declares nothing resolves to NO constraint — the invisible regression", () => {
		expect(constraintsFor(agentCapabilities(declared({ surfaces: ["coding"] })), "terminal")).toBeUndefined();
		expect(constraintsFor(agentCapabilities({ slug: "coder", category: "code", config: null }), "terminal")).toBeUndefined();
	});
});

/** A DB whose one row carries the given agent + instance configs. `null` = instance not found. */
function envWithConfigs(agentConfig: unknown, instanceConfig: unknown, found = true) {
	return {
		DB: {
			prepare() {
				return {
					bind() {
						return {
							first: async () =>
								found
									? { agent_config: agentConfig == null ? null : JSON.stringify(agentConfig), instance_config: instanceConfig == null ? null : JSON.stringify(instanceConfig) }
									: null,
						};
					},
				};
			},
		},
	} as unknown as Parameters<typeof connectorConstraintsForInstance>[0];
}

describe("connectorConstraintsForInstance — creator ceiling, subscriber narrowing", () => {
	const ceiling = (backends: string[]) => ({ capabilities: { surfaces: ["tmux"], surfaceOptions: { terminal: { backends } } } });

	it("returns the creator's ceiling when the subscriber has asked for nothing", async () => {
		const env = envWithConfigs(ceiling(["tmux"]), {});
		expect(await connectorConstraintsForInstance(env, "i1", "u1", "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("lets the subscriber NARROW within the ceiling", async () => {
		const env = envWithConfigs(ceiling(["tmux", "kitty"]), { surfaceOptions: { terminal: { backends: ["tmux"] } } });
		expect(await connectorConstraintsForInstance(env, "i1", "u1", "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("does NOT let the subscriber widen it — the ceiling is a catalog claim", async () => {
		// Configuration must never make an agent's own description false (#362).
		const env = envWithConfigs(ceiling(["tmux"]), { surfaceOptions: { terminal: { backends: ["tmux", "iterm2"] } } });
		expect(await connectorConstraintsForInstance(env, "i1", "u1", "terminal")).toEqual({ backends: ["tmux"] });

		const wholly = envWithConfigs(ceiling(["tmux"]), { surfaceOptions: { terminal: { backends: ["iterm2"] } } });
		expect(await connectorConstraintsForInstance(wholly, "i1", "u1", "terminal")).toEqual({ backends: ["tmux"] });
	});

	it("honours a subscriber's narrowing of an agent that declared no ceiling", async () => {
		const env = envWithConfigs({ capabilities: { surfaces: ["tmux"] } }, { surfaceOptions: { terminal: { backends: ["kitty"] } } });
		expect(await connectorConstraintsForInstance(env, "i1", "u1", "terminal")).toEqual({ backends: ["kitty"] });
	});

	it("resolves to undefined when neither side declares anything, and when the row is gone", async () => {
		expect(await connectorConstraintsForInstance(envWithConfigs({ capabilities: {} }, {}), "i1", "u1", "terminal")).toBeUndefined();
		expect(await connectorConstraintsForInstance(envWithConfigs(null, null), "i1", "u1", "terminal")).toBeUndefined();
		expect(await connectorConstraintsForInstance(envWithConfigs(ceiling(["tmux"]), {}, false), "i1", "u1", "terminal")).toBeUndefined();
	});

	it("propagates a database failure rather than resolving to 'unconstrained'", async () => {
		// The caller refuses on a throw. A ceiling that cannot be read cannot be honoured, and a
		// boundary that opens when its store hiccups is not a boundary.
		const env = { DB: { prepare() { return { bind() { return { first: async () => { throw new Error("D1 down"); } }; } }; } } } as never;
		await expect(connectorConstraintsForInstance(env, "i1", "u1", "terminal")).rejects.toThrow(/D1 down/);
	});
});

describe("columnForStatus — the canonical bucketing rule", () => {
	const cols = [
		{ id: "running", title: "Running", color: "#000", statuses: ["running", "in_progress"] },
		{ id: "needs_human", title: "Needs you", color: "#000", statuses: ["needs_human"] },
		{ id: "other", title: "Other", color: "#000", catchAll: true },
	];

	it("matches a declared status", () => {
		expect(columnForStatus(cols, "in_progress")?.id).toBe("running");
	});

	it("also matches a column's own id — the two existing copies do, so this must too", () => {
		// store/console BoardTab and workers/mcp shared.ts both accept `c.id === status`; a
		// canonical rule that dropped it would silently re-bucket live cards.
		expect(columnForStatus(cols, "needs_human")?.id).toBe("needs_human");
		expect(columnForStatus([{ id: "blocked", title: "Blocked", color: "#000" }], "blocked")?.id).toBe("blocked");
	});

	it("first match wins, so column order is the tiebreak", () => {
		const dup = [
			{ id: "a", title: "A", color: "#000", statuses: ["x"] },
			{ id: "b", title: "B", color: "#000", statuses: ["x"] },
		];
		expect(columnForStatus(dup, "x")?.id).toBe("a");
	});

	it("falls back to catchAll for an unclaimed status", () => {
		expect(columnForStatus(cols, "wat")?.id).toBe("other");
	});

	it("returns null when nothing claims it and there is no catchAll — a null is information", () => {
		// It says the agent is writing a status its own declaration never claimed, which a
		// supervisor should surface rather than guess about.
		expect(columnForStatus(cols.slice(0, 2), "wat")).toBeNull();
		expect(columnForStatus([], "running")).toBeNull();
	});
});

describe("customSurfaces.ownsHeader — a published surface is not a second-class citizen", () => {
	// Absolute https on a platform host — `isAllowedBundleUrl` rejects a relative path, and a
	// fixture that fails THAT check would pass these assertions for the wrong reason.
	const surf = (extra: Record<string, unknown> = {}) => [{
		id: "notes", label: "Notes", bundleUrl: "https://proagentstore.online/console/surfaces/notes.js", ...extra,
	}];

	it("survives sanitizing when declared", () => {
		// The whole point: a whitelist sanitizer that drops an unknown field lets a creator declare
		// a capability and watch it silently do nothing — the failure `parseConfig` is already
		// documented for. If this field is not carried through, the console never sees it.
		expect(sanitizeCustomSurfaces(surf({ ownsHeader: true }), ON)?.[0].ownsHeader).toBe(true);
	});

	it("is absent unless EXPLICITLY true — a truthy string must not grant it", () => {
		// Replacing the page header is a takeover of shell chrome; it should need a real boolean,
		// not any value that happens to be truthy in JSON.
		for (const v of [undefined, null, 0, 1, "", "true", "yes", {}, []]) {
			expect(sanitizeCustomSurfaces(surf({ ownsHeader: v }), ON)?.[0].ownsHeader, String(v)).toBeUndefined();
		}
		expect(sanitizeCustomSurfaces(surf(), ON)?.[0].ownsHeader).toBeUndefined();
	});

	it("does not weaken the checks that keep a bundle safe", () => {
		// Declaring a capability must not become a way past the same-origin + reserved-id gates.
		expect(sanitizeCustomSurfaces([{ id: "chat", label: "X", bundleUrl: "https://proagentstore.online/x.js", ownsHeader: true }], ON)).toBeUndefined();
		expect(sanitizeCustomSurfaces([{ id: "notes", label: "X", bundleUrl: "https://evil.example/x.js", ownsHeader: true }], ON)).toBeUndefined();
	});
});

