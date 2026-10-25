/** Haiku is reserved for ticket triage/queueing, never a coding engine.
 * Mirrored in the API's coding-engine-policy.ts; behavior parity is tested here.
 */
export const CODING_HAIKU_REFUSAL = "Haiku is not permitted for coding engines. Choose a non-Haiku model; Haiku is reserved for ticket triage and queueing.";

export function isHaikuCodingModel(model: string): boolean {
	return /(?:^|[/:._-])haiku(?:$|[/:._[\]-])/i.test(model.trim().replace(/^["']|["']$/g, ""));
}

/** Inspect model values only: a repository path, prompt or unrelated argument is not a model. */
export function codingEngineModelProblem(command?: string | null, env?: Record<string, string | undefined>, clientType?: string): string | null {
	const tokens = (command?.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""));
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		let model: string | undefined;
		if (["--model", "--fallback-model", "-m"].includes(token)) model = tokens[++i];
		else if (/^(?:--model|--fallback-model|model)=/.test(token) || (clientType === "claude" && token.startsWith("ANTHROPIC_MODEL="))) model = token.slice(token.indexOf("=") + 1);
		if (model && isHaikuCodingModel(model)) return CODING_HAIKU_REFUSAL;
	}
	return clientType === "claude" && env?.ANTHROPIC_MODEL && isHaikuCodingModel(env.ANTHROPIC_MODEL) ? CODING_HAIKU_REFUSAL : null;
}
