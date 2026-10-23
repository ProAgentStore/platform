/**
 * #1043 in the console: the Brain-model card is separate from the Coding engine in wording and layout,
 * confirms provider, model, cost and billing before saving, and offers Cloudflare only with Cloudflare
 * credentials. Components rendered as real markup.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainConfirmDialog, BrainModelPicker } from "../components/BrainModelCard";
import { BRAIN_CARD_SCOPE, BRAIN_SURFACES, ENGINE_CARD_SCOPE, brainConfirmation, brainOptions, storedBrainKeys } from "./brainChoice";

const noCloudflare = brainOptions({ anthropic: true, cloudflare: false });
const withCloudflare = brainOptions({ anthropic: true, cloudflare: true });
const scout = (opts: ReturnType<typeof brainOptions>) => opts.find((o) => o.label === "Llama 4 Scout 17B")!;

describe("Brain options (#1043)", () => {
	it("offers the four brain models with provider and cost note — and no DeepSeek", () => {
		expect(withCloudflare.map((o) => [o.label, o.providerLabel])).toEqual([
			["Claude Sonnet 4.6", "Anthropic"],
			["Llama 4 Scout 17B", "Cloudflare Workers AI"],
			["Llama 3.3 70B", "Cloudflare Workers AI"],
			["Qwen 2.5 Coder 32B", "Cloudflare Workers AI"],
		]);
		expect(withCloudflare.every((o) => o.costNote.length > 0)).toBe(true);
		expect(JSON.stringify(withCloudflare)).not.toMatch(/deepseek/i);
	});

	it("Cloudflare choices are unavailable without Cloudflare credentials, and say what is needed — before any save", () => {
		expect(noCloudflare.filter((o) => o.provider === "cloudflare").every((o) => !o.available && /Cloudflare account ID and API token/.test(o.prerequisite ?? ""))).toBe(true);
		expect(withCloudflare.every((o) => o.available && o.prerequisite === null)).toBe(true);
		expect(storedBrainKeys({ providers: [{ id: "cloudflare", hasKey: true }, { id: "anthropic", hasKey: false }] })).toEqual({ anthropic: false, cloudflare: true });
		// Unknown (the lookup failed) is not "missing": offered, and the API decides.
		expect(brainOptions({ anthropic: null, cloudflare: null }).every((o) => o.available)).toBe(true);
	});

	it("the picker renders unavailable Cloudflare options disabled, with the prerequisite listed", () => {
		const html = renderToStaticMarkup(createElement(BrainModelPicker, { options: noCloudflare, value: "claude-sonnet-4-6", onPick: () => {} }));
		expect(html).toMatch(/<option value="@cf\/meta\/llama-4-scout-17b-16e-instruct" disabled="">/);
		expect(html).toMatch(/data-testid="brain-prerequisites".*Llama 4 Scout 17B: Needs your Cloudflare account ID and API token/s);
		expect(html).not.toMatch(/<option value="claude-sonnet-4-6" disabled/);
	});
});

describe("the confirmation before saving (#1043)", () => {
	it("shows provider, model, cost note and an API-billing warning naming the provider", () => {
		expect(brainConfirmation(scout(withCloudflare))).toEqual({
			provider: "Cloudflare Workers AI",
			model: "Llama 4 Scout 17B",
			costNote: expect.stringMatching(/cheap/),
			billingWarning: expect.stringMatching(/Billed per token to your own Cloudflare Workers AI account, separately from any subscription.*coding engine stays on your subscription CLI/),
		});
		expect(brainConfirmation(withCloudflare[0]).billingWarning).toMatch(/your own Anthropic API key/);
	});

	it("renders as a dialog with each fact and which surfaces it drives (not the Pilot)", () => {
		const html = renderToStaticMarkup(createElement(BrainConfirmDialog, { option: scout(withCloudflare), onConfirm: () => {}, onCancel: () => {} }));
		expect(html).toContain('role="dialog"');
		expect(html).toMatch(/data-testid="brain-confirm-provider">Cloudflare Workers AI</);
		expect(html).toMatch(/data-testid="brain-confirm-model">Llama 4 Scout 17B</);
		expect(html).toMatch(/data-testid="brain-confirm-cost">cheap/);
		expect(html).toMatch(/data-testid="brain-confirm-billing">Billed per token to your own Cloudflare/);
		expect(html).toMatch(/The Pilot controller has its own model setting/);
	});
});

describe("Brain and Coding engine are separate in wording and layout (#1043)", () => {
	it("each card says what it is, and the engine card says the Brain never changes it", () => {
		expect(BRAIN_CARD_SCOPE).toMatch(/Advisory and orchestration only\. It never edits, tests or deploys code/);
		expect(ENGINE_CARD_SCOPE).toMatch(/subscription CLI.*only thing that edits, tests and deploys code.*Brain model above never changes it/);
		expect(BRAIN_SURFACES).toMatch(/coding engine stays your subscription CLI/);
	});

	it("Settings puts them in two headed sections — the Brain's, then Coding's — never side by side in one", () => {
		const tab = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../tabs/SettingsTab.tsx"), "utf8");
		const brain = tab.indexOf('data-testid="settings-brain-section"');
		const coding = tab.indexOf('data-testid="settings-coding-section"');
		expect(brain).toBeGreaterThan(0);
		expect(coding).toBeGreaterThan(brain);
		expect(tab.slice(brain, coding)).toMatch(/Brain — advises and orchestrates[\s\S]*<BrainModelCard[\s\S]*<CoderBrainSection/);
		expect(tab.slice(brain, coding)).not.toMatch(/<CodingEngineCard/);
		expect(tab.slice(coding)).toMatch(/Coding — edits, tests and deploys[\s\S]*<CodingEngineCard/);
	});
});
