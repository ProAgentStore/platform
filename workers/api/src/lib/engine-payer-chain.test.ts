import { beforeEach, describe, expect, it, vi } from "vitest";
import { payerForEngineAuth } from "./usage-payer.js";
import { resolveEngineAuth } from "../../../../packages/browser-runner/src/coding/engine-auth.js";
import { mergeEnv } from "../../../../packages/browser-runner/src/coding/engine-env.js";
import type { Env } from "../types.js";

/**
 * The hops from "no token stored" to "Payer not established", asserted end to end (#551).
 *
 * Each hop is already tested where it lives. Nothing tested the CHAIN, and the chain is the
 * finding: on a real account 99.62% of the notional AI value — 3,462 calls, $9,584.87 — arrives
 * with a NULL payer, and every hop that produced it is individually correct.
 *
 *   1. `resolveEngineEnv`, `auto` mode, no stored `claude-code` key → `{ ANTHROPIC_API_KEY: "" }`
 *   2. the runner's `mergeEnv` reads "" as DELETE, so the spawn env has neither credential
 *   3. `resolveEngineAuth` sees neither → "machine-login"
 *   4. `payerForEngineAuth("machine-login")` → null
 *   5. NULL is excluded from every charged figure (`isCharged`, `CHARGED_SQL`)
 *
 * This is a DISCLOSED gap, not a silent one, and that is what these assertions pin. The temptation
 * a future reader will feel is to map `machine-login` to `subscription` and "fix" the unknown
 * bucket. It is the MOST COMMON resolution, so it would be wrong most often, and it would zero the
 * charged figure for someone genuinely paying per token. The remedy is a stored token, and the
 * console now says so on both surfaces where the ambiguity is created and where it is chosen.
 *
 * It imports the runner's own `mergeEnv` and `resolveEngineAuth` rather than restating their
 * rules: a chain test that paraphrases a hop cannot catch that hop changing. Only the vault read
 * is mocked, because "is a token stored" is the one input the test is varying.
 */

vi.mock("./user-ai.js", () => ({ getUserProviderKey: vi.fn() }));
const userAi = await import("./user-ai.js");
const { engineAuthFor, engineAuthReport, resolveEngineEnv } = await import("./coding-engines.js");

/** Engine presets come from D1; this instance has none stored, so the defaults apply (auto). */
const dbEnv = () =>
	({
		DB: {
			prepare() {
				return { bind() { return { async first() { return null; }, async all() { return { results: [] }; } }; } };
			},
		},
	}) as unknown as Env;

const claudeSession = (over: Record<string, unknown> = {}) =>
	({ id: "s1", clientType: "claude", launchCommand: "claude --dangerously-skip-permissions", ...over }) as never;

describe("what a coding engine signs in with decides whether its spend can be attributed (#551)", () => {
	beforeEach(() => vi.mocked(userAi.getUserProviderKey).mockReset());

	it("auto with NO stored token ends at a null payer — even on a machine whose shell exports a key", async () => {
		vi.mocked(userAi.getUserProviderKey).mockResolvedValue(null);
		const overlay = await resolveEngineEnv(dbEnv(), "i1", "u1", claudeSession());
		expect(overlay).toEqual({ ANTHROPIC_API_KEY: "" });

		// The machine's shell has a key. Stripping it is the point of the mode (#248): "auto" must
		// not silently become per-token billing. What it costs is attribution.
		const spawnEnv = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-from-the-shell", PATH: "/usr/bin" }, overlay);
		expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
		expect(spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

		const resolved = resolveEngineAuth("claude", spawnEnv as Record<string, string | undefined>);
		expect(resolved).toBe("machine-login");
		expect(payerForEngineAuth(resolved)).toBeNull();
	});

	it("auto WITH a stored token ends at `subscription` — the remedy both surfaces name", async () => {
		// One stored `claude setup-token` moves the largest row on the Usage page from "Payer not
		// established" to "Drawn from a subscription". Asserted against the code that would honour
		// the advice, so the advice cannot quietly stop being true.
		vi.mocked(userAi.getUserProviderKey).mockResolvedValue("sk-ant-oat-stored");
		const overlay = await resolveEngineEnv(dbEnv(), "i1", "u1", claudeSession());
		expect(overlay).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-stored", ANTHROPIC_API_KEY: "" });

		const spawnEnv = mergeEnv({ ANTHROPIC_API_KEY: "sk-ant-from-the-shell" }, overlay);
		const resolved = resolveEngineAuth("claude", spawnEnv as Record<string, string | undefined>);
		expect(resolved).toBe("subscription");
		expect(payerForEngineAuth(resolved)).toBe("subscription");
	});

	it("an explicit api-key mode is the other attributable answer, and it IS money", async () => {
		vi.mocked(userAi.getUserProviderKey).mockResolvedValue("sk-ant-api-key");
		const session = claudeSession({ launchCommand: "claude --key" });
		const dbWithKeyPreset = {
			DB: {
				prepare() {
					return {
						bind() {
							return {
								async first() {
									return { config: JSON.stringify({ codingEngines: [{ id: "key", label: "K", command: "claude --key", auth: "api-key" }] }) };
								},
								async all() { return { results: [] }; },
							};
						},
					};
				},
			},
		} as unknown as Env;
		const overlay = await resolveEngineEnv(dbWithKeyPreset, "i1", "u1", session);
		expect(overlay).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api-key" });

		const resolved = resolveEngineAuth("claude", mergeEnv({}, overlay) as Record<string, string | undefined>);
		expect(resolved).toBe("api-key");
		expect(payerForEngineAuth(resolved)).toBe("byok-api");
	});
});

describe("Codex ChatGPT subscription: the OpenAI key is kept away from `codex login` (#732)", () => {
	beforeEach(() => vi.mocked(userAi.getUserProviderKey).mockReset());

	const codexSub = { id: "codex", label: "Codex", command: "codex exec --json --sandbox danger-full-access", auth: "subscription" as const };
	const dbWith = (engines: unknown[]) =>
		({
			DB: {
				prepare() {
					return {
						bind() {
							return {
								async first() { return { config: JSON.stringify({ codingEngines: engines }) }; },
								async all() { return { results: [] }; },
							};
						},
					};
				},
			},
		}) as unknown as Env;
	const codexSession = { id: "s1", clientType: "codex", launchCommand: codexSub.command } as never;

	it("strips OPENAI_API_KEY even with a vault key saved AND one exported in the shell", async () => {
		// The machine the BA correction asked about: `codex login` active and a key in the shell.
		// The saved vault key must not be injected, and the shell key must not be inherited.
		vi.mocked(userAi.getUserProviderKey).mockResolvedValue("sk-openai-vault");
		const overlay = await resolveEngineEnv(dbWith([codexSub]), "i1", "u1", codexSession);
		expect(overlay).toEqual({ OPENAI_API_KEY: "" });
		expect(userAi.getUserProviderKey).not.toHaveBeenCalled();

		const spawnEnv = mergeEnv({ OPENAI_API_KEY: "sk-openai-from-the-shell", PATH: "/usr/bin" }, overlay);
		expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();

		const resolved = resolveEngineAuth("codex", spawnEnv as Record<string, string | undefined>);
		expect(resolved).not.toBe("api-key");
		const report = engineAuthReport(engineAuthFor([codexSub], codexSub.command), resolved, "codex");
		expect(report).toMatchObject({ mode: "subscription", engine: "codex", resolved: "machine-login", warning: null, payer: null });
		expect(report.note).toMatch(/codex login/);
		expect(report.note).toMatch(/ChatGPT plan/);
	});

	it("an old runner that ignores the strip lets the shell key win — and the report says so, in Codex's words", async () => {
		const spawnEnv = mergeEnv({ OPENAI_API_KEY: "sk-openai-from-the-shell" }, undefined);
		const resolved = resolveEngineAuth("codex", spawnEnv as Record<string, string | undefined>);
		const report = engineAuthReport("subscription", resolved, "codex");
		expect(report.warning).toMatch(/ChatGPT subscription/);
		expect(report.warning).toMatch(/OpenAI API key/);
		expect(report.warning).toMatch(/billing per token/i);
		expect(report.payer).toBe("byok-api");
	});

	it("api-key mode still injects the vault OpenAI key", async () => {
		vi.mocked(userAi.getUserProviderKey).mockResolvedValue("sk-openai-vault");
		const codexKey = { ...codexSub, auth: "api-key" as const };
		const overlay = await resolveEngineEnv(dbWith([codexKey]), "i1", "u1", codexSession);
		expect(overlay).toEqual({ OPENAI_API_KEY: "sk-openai-vault" });
	});
});
