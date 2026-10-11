import type { Page } from "playwright";
import { RunnerInputError } from "../errors.js";
import type { TakeoverInput } from "../types.js";
import type { LocalApplyHandoffRequest } from "./contract.js";
import type { LocalApplyTakeoverAdapter } from "./runtime-handoff.js";

const prefix = "local-apply:";

export function isLocalApplyTakeover(id: string): boolean { return id.startsWith(prefix); }

/** Attach the bounded local-apply view to the runner's existing live-page takeover machinery. */
export function createLocalApplyTakeoverAdapter(deps: {
	activePage(): Page | null;
	get(id: string): { page: Page } | undefined;
	set(id: string, page: Page): void;
	frame(id: string): Promise<{ frame: string; width: number; height: number }>;
	input(id: string, input: TakeoverInput): Promise<void>;
	end(id: string): Promise<void>;
}): LocalApplyTakeoverAdapter {
	const key = (handoffId: string) => `${prefix}${handoffId}`;
	return {
		async open(request: LocalApplyHandoffRequest): Promise<void> {
			if (request.browserProfile !== "default") throw new RunnerInputError("This browser profile has no live handoff page", 409);
			const id = key(request.handoffId);
			if (deps.get(id)) throw new RunnerInputError("A local application handoff already exists", 409);
			// Do not create a page here: a destroyed page must remain a lost handoff, never look ready.
			const page = deps.activePage();
			if (!page || page.isClosed()) throw new RunnerInputError("The local application page is no longer available", 409);
			deps.set(id, page);
		},
		async state(handoffId: string): Promise<"ready" | "page_lost"> {
			const session = deps.get(key(handoffId));
			return session && !session.page.isClosed() ? "ready" : "page_lost";
		},
		frame: (handoffId) => deps.frame(key(handoffId)),
		input: (handoffId, input) => deps.input(key(handoffId), input),
		end: (handoffId) => deps.end(key(handoffId)),
	};
}
