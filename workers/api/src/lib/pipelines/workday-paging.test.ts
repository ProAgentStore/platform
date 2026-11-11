// Pipeline-level proof for issue #1634: a minimal, pure-JSON pipeline pages a FIXTURE Workday
// job-search tenant through the real runner (executePipelineStep → the real tool registry →
// the real fan_out + http_request handlers), with NO write consent granted on the connection —
// proving the read-shaped-POST exemption (connectors/http.ts READ_SHAPED_POST) lets an offset-
// paged Workday sweep run without ever reaching the write-consent gate. Only the one true I/O
// boundary, globalThis.fetch, is mocked; everything else (tool-registry dispatch, fan_out's
// offset-paging loop, http_request's interpolation/consent/safeFetch path) runs for real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { executePipelineStep, validatePipeline, type PipelineDef, type PipelineRunCtx } from "../pipeline.js";
import type { Env } from "../../types.js";

/**
 * A fixture Workday CXS job-search tenant: 60 jobs total, served 20 at a time (the shape the
 * real endpoint uses — `{offset,limit}` in, `{total,jobPostings}` out). No GET equivalent exists,
 * which is exactly why #1634's READ_SHAPED_POST exemption is needed for this endpoint.
 */
const WORKDAY_URL = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs";
const TOTAL_JOBS = 60;
const PAGE_SIZE = 20;

function workdayPipeline(): PipelineDef {
	return {
		name: "workday_paging_fixture",
		steps: [
			{
				tool: "fan_out",
				bind: "pages",
				inputs: {
					mode: "pages",
					offsetParam: "offset",
					limitParam: "limit",
					pageSize: PAGE_SIZE,
					totalPath: "data.total",
					itemsPath: "data.jobPostings",
					maxPages: 10,
					request: {
						method: "POST",
						url: WORKDAY_URL,
						body: { appliedFacets: {}, searchText: "", limit: "{{limit}}", offset: "{{offset}}" },
					},
				},
			},
		],
	};
}

/** A DB whose consent lookup is spied on, so the test can assert it was NEVER consulted. */
function consentDb(granted: boolean) {
	const first = vi.fn(async () => (granted ? { ok: 1 } : null));
	const bind = vi.fn(() => ({ first }));
	const prepare = vi.fn(() => ({ bind }));
	return { prepare, bind, first };
}

describe("pipeline: Workday offset paging through the real runner (#1634)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is a valid pipeline definition (known tool, well-formed step)", () => {
		expect(validatePipeline(workdayPipeline())).toBeNull();
	});

	it("pages a 3-page fixture Workday tenant with NO write consent granted, and never consults the consent DB", async () => {
		const seenOffsets: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const sent = JSON.parse(String(init?.body ?? "{}")) as { offset: number; limit: number };
			// #1634: the body must carry the resolved NUMBER offset/limit, not a stringified one —
			// Workday 400s a stringified offset. Asserted here as a side effect of driving it
			// through the real http_request handler, not re-derived as a separate unit claim.
			expect(typeof sent.offset).toBe("number");
			expect(typeof sent.limit).toBe("number");
			seenOffsets.push(String(sent.offset));
			const remaining = TOTAL_JOBS - sent.offset;
			const n = Math.max(0, Math.min(PAGE_SIZE, remaining));
			const jobPostings = Array.from({ length: n }, (_, i) => ({ id: `R-${sent.offset + i}` }));
			return new Response(JSON.stringify({ total: TOTAL_JOBS, jobPostings }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		// Consent DB denies write — and because the Workday endpoint is matched by
		// READ_SHAPED_POST, http_request's per-call gate never asks it in the first place.
		const db = consentDb(false);
		const env = { DB: db } as unknown as Env;
		const ctx: PipelineRunCtx = { env, userId: "u1", instanceId: "inst1" };

		const def = workdayPipeline();
		const r = await executePipelineStep(ctx, def.steps[0], 0, {}, {});

		expect(r.success).toBe(true);
		// `fan_out` is declared `untrustedOutput: true` (it threads a remote HTTP body), so
		// `r.content` carries an untrusted-content fence (#308) — `r.output` is the already
		// unfenced, parsed value the runner binds for later steps' `$ref`s.
		expect(r.output).toMatchObject({ pages: 3, count: TOTAL_JOBS, hasMore: false });
		expect(seenOffsets).toEqual(["0", "20", "40"]);

		// The proof that matters: the write-consent lookup was never reached at all, because
		// isReadShapedRequest() short-circuits before hasConsent() would query it.
		expect(db.prepare).not.toHaveBeenCalled();
	});
});
