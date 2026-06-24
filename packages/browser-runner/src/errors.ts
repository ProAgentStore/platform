/** Raised when the model/runner cannot proceed and a human must take over. */
export class HumanHandoffError extends Error {
	constructor(
		message: string,
		readonly handoff: {
			reason: "challenge" | "exhausted_attempts" | "assist";
			challengeType?: string;
			url: string;
			attempts: number;
			screenshotBase64?: string;
		},
	) {
		super(message);
		this.name = "HumanHandoffError";
	}
}

/** A bad client request to the runner (maps to HTTP 400). */
export class RunnerInputError extends Error {
	readonly status = 400;
}
