/**
 * The #1112 fixtures as GitHub's API: a `fetch` stand-in answering the three reads the never-started
 * diagnosis makes — a run's jobs, a check run's annotations, a job's log — from one fixture file.
 * Anything else is a 404, so a test can never reach the network by accident. Test-only.
 */
import billingAnnotation from "./billing-annotation.json" with { type: "json" };
import inaccessibleAnnotations from "./inaccessible-annotations.json" with { type: "json" };
import ordinaryFailure from "./ordinary-failure.json" with { type: "json" };

export interface ActionsFixture {
	run?: Record<string, unknown>;
	jobs: { total_count: number; jobs: Array<Record<string, unknown>> };
	annotations?: unknown[];
	annotationsResponse?: { status: number; body: unknown };
	log: { status: number; text?: string };
}

const FIXTURES = { "billing-annotation": billingAnnotation, "ordinary-failure": ordinaryFailure, "inaccessible-annotations": inaccessibleAnnotations };

/** A fresh copy each call, so a test that edits its fixture cannot leak into the next. */
export function loadActionsFixture(name: keyof typeof FIXTURES): ActionsFixture {
	return structuredClone(FIXTURES[name]) as unknown as ActionsFixture;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Every URL this fetch was asked for, in order — so a test can say what was (not) read. */
export function fixtureFetch(fx: ActionsFixture): { fetch: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const impl = async (input: RequestInfo | URL): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (/\/actions\/runs\/\d+\/jobs/.test(url)) return json(fx.jobs);
		if (/\/check-runs\/\d+\/annotations/.test(url)) return fx.annotationsResponse ? json(fx.annotationsResponse.body, fx.annotationsResponse.status) : json(fx.annotations ?? []);
		if (/\/actions\/jobs\/\d+\/logs/.test(url)) return fx.log.status === 200 ? new Response(fx.log.text ?? "") : json({ message: "Not Found" }, fx.log.status);
		return json({ message: "Not Found" }, 404);
	};
	return { fetch: impl as typeof fetch, urls };
}
