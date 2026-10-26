/** #1356 — one place decides an AI provider refusal's kind; everything else reads it. */
import { describe, expect, it } from "vitest";
import { classifyCodingFailure } from "./coding-failure.js";
import { parseCloudflareAiCredentials } from "./cloudflare-credentials.js";
import { providerCredentialId } from "./provider-account-observation.js";
import { classifyAnthropicError, classifyCloudflareError, isCreditBalanceMessage, providerErrorKind, providerErrorTag, withoutProviderErrorTag } from "./provider-error-kind.js";
import { UserAiProviderError } from "./user-ai.js";

describe("classifyAnthropicError", () => {
	it("reads the credit sentence before the status: an exhausted balance is never filed as a bad key", () => {
		const credit = "Your credit balance is too low to access the Anthropic API.";
		expect(classifyAnthropicError({ status: 400, message: credit })).toBe("credit");
		expect(classifyAnthropicError({ status: 401, message: credit })).toBe("credit");
		expect(classifyAnthropicError({ status: 403, message: credit })).toBe("credit");
		expect(classifyAnthropicError({ status: 402, message: "Payment required" })).toBe("credit");
	});

	it("files a refused key, a model the key cannot reach, a throttle and a provider failure each under its own kind", () => {
		expect(classifyAnthropicError({ status: 401, message: "invalid x-api-key" })).toBe("credentials");
		expect(classifyAnthropicError({ status: 403, message: "Request not allowed" })).toBe("credentials");
		expect(classifyAnthropicError({ status: 404, message: "model: claude-x" })).toBe("model_access");
		expect(classifyAnthropicError({ status: 429, message: "rate limited" })).toBe("rate_limit");
		for (const status of [500, 502, 529]) expect(classifyAnthropicError({ status, message: "overloaded" }), String(status)).toBe("server");
		expect(classifyAnthropicError({ status: 400, message: "messages: roles must alternate" })).toBe("other");
	});

	it("a malformed request that merely mentions 'credit' elsewhere is not a balance failure", () => {
		expect(classifyAnthropicError({ status: 400, message: "tool_use ids must be unique; see the credits page" })).toBe("other");
		expect(isCreditBalanceMessage("Your credit balance is too low")).toBe(true);
	});
});

describe("classifyCloudflareError", () => {
	it("speaks only in status", () => {
		expect(classifyCloudflareError({ status: 401 })).toBe("credentials");
		expect(classifyCloudflareError({ status: 403 })).toBe("credentials");
		expect(classifyCloudflareError({ status: 402 })).toBe("credit");
		expect(classifyCloudflareError({ status: 429 })).toBe("rate_limit");
		expect(classifyCloudflareError({ status: 503 })).toBe("server");
		expect(classifyCloudflareError({ status: 400 })).toBe("other");
	});
});

describe("the kind travels with the error, including across a step boundary", () => {
	it("round-trips through the tag, which a step boundary keeps when it drops the field", () => {
		const e = new UserAiProviderError(`Anthropic (400): nope${providerErrorTag("credit")}`, 502, 400, undefined, false, "credit");
		expect(providerErrorKind(e)).toBe("credit");
		const flattened = new Error(e.message); // what the workflow hands the next reader
		expect(providerErrorKind(flattened)).toBe("credit");
		expect(withoutProviderErrorTag(e.message)).toBe("Anthropic (400): nope");
	});

	it("a field outranks a tag, an unknown tag is no kind, and an untagged message has none", () => {
		expect(providerErrorKind({ kind: "credentials", message: `x${providerErrorTag("credit")}` })).toBe("credentials");
		expect(providerErrorKind(new Error("x [provider-error:martian]"))).toBeNull();
		expect(providerErrorKind(new Error("Anthropic (400): Your credit balance is too low"))).toBeNull();
		expect(providerErrorKind(null)).toBeNull();
	});
});

describe("the failure classifier reads the adapter's verdict, not the wording again", () => {
	const flat = (message: string) => new Error(message);

	it("a tagged credit failure is provider_credit even though the wording says nothing a marker list would match", () => {
		expect(classifyCodingFailure(flat(`The vendor changed its sentence entirely${providerErrorTag("credit")}`)).class).toBe("provider_credit");
		expect(classifyCodingFailure(flat(`Reworded refusal${providerErrorTag("credentials")}`)).class).toBe("provider_credentials");
		expect(classifyCodingFailure(flat(`Slow down${providerErrorTag("rate_limit")}`)).class).toBe("provider_rate_limit");
	});

	it("the kind wins over contradictory wording: the decision is made once, by the adapter", () => {
		// The words alone would have filed this as a bad key; the adapter, with the status in hand, said credit.
		expect(classifyCodingFailure(flat(`Anthropic (401): invalid api key${providerErrorTag("credit")}`)).class).toBe("provider_credit");
	});

	it("an untagged message — an older run, a message not written by an adapter — keeps its wording-based reading", () => {
		expect(classifyCodingFailure(flat("Anthropic (400): Your credit balance is too low to access the Anthropic API.")).class).toBe("provider_credit");
		expect(classifyCodingFailure(flat("Anthropic (401): Invalid API key")).class).toBe("provider_credentials");
	});

	it("a tagged server or other failure falls through to the ordinary reading", () => {
		expect(classifyCodingFailure(flat(`Anthropic (529): overloaded${providerErrorTag("server")}`)).class).toBe("provider_error");
	});
});

describe("one Cloudflare credential parser (#1356)", () => {
	const fingerprint = (c: string | { accountId: string; token: string }) => providerCredentialId("cloudflare", c);

	it("the JSON envelope and the colon form fingerprint the same credential, trimmed", async () => {
		const a = await fingerprint(JSON.stringify({ accountId: " acct ", token: " tok " }));
		const b = await fingerprint("acct:tok");
		const c = await fingerprint({ accountId: "acct", token: "tok" });
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("a value with no colon is refused, not turned into a made-up account id", async () => {
		// The observation module's old copy took `slice(0, -1)` of the whole string as the account and the rest as the token.
		await expect(fingerprint("justonestring")).rejects.toThrow(/could not be checked/);
		expect(parseCloudflareAiCredentials("justonestring")).toBeNull();
		await expect(fingerprint(":tokenonly")).rejects.toThrow(/could not be checked/);
		await expect(fingerprint("accountonly:")).rejects.toThrow(/could not be checked/);
		await expect(fingerprint("{not json")).rejects.toThrow();
	});

	it("is the same parser user-ai reads the stored credential with", async () => {
		const { parseCloudflareAiCredentials: viaUserAi } = await import("./user-ai.js");
		expect(viaUserAi).toBe(parseCloudflareAiCredentials);
	});
});

describe("isCredentialsError reads the adapter's kind (#1355)", () => {
	it("a credit refusal that talks about the API key is not a missing key", async () => {
		const { isCredentialsError } = await import("./loop-orchestrator.js");
		expect(isCredentialsError(new Error(`Your credit balance is too low for this API key${providerErrorTag("credit")}`))).toBe(false);
		expect(isCredentialsError(new Error(`Anthropic refused the key${providerErrorTag("credentials")}`))).toBe(true);
	});
	it("a missing key is credentials by construction, and survives flattening", async () => {
		const { isCredentialsError } = await import("./loop-orchestrator.js");
		const { UserAiCredentialsError } = await import("./user-ai-errors.js");
		expect(isCredentialsError(new Error(new UserAiCredentialsError("Add a thing").message))).toBe(true);
		expect(new UserAiCredentialsError().kind).toBe("credentials");
	});
	it("an untagged message still falls back to its wording", async () => {
		const { isCredentialsError } = await import("./loop-orchestrator.js");
		expect(isCredentialsError(new Error("No API key configured"))).toBe(true);
	});
});
