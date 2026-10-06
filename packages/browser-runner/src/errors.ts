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

/** A bad client request to the runner (HTTP 400 by default; 404/409 where the request names a missing or busy thing). */
export class RunnerInputError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
