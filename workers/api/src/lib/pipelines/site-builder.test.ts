// The site-builder as a PURE DECLARATIVE PIPELINE — "take a lead, build that business a
// website" expressed as data, driven end-to-end through the REAL runner
// (executePipelineStep) and the REAL step handlers (slice/flatten/map/parse_json/
// extract_contacts from steps.ts). Only the true I/O boundaries are mocked: outbound HTTP
// (Places details + photo media), the web-search connector, the owner's BYOK model, the
// outbound MCP server, the board, and the collection sink.
//
// What this proves: the third agent in the lead chain needs NO bespoke Worker either. The
// only new machinery is the generic outbound-MCP connector; the shape of the work —
// look up → enrich → draft → build → gate on a human → record — is configuration.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FENCE_TAG } from "../untrusted-fence.js";
import { renderWithFencedValues } from "../prompt-interpolation.js";
import siteBuilder from "./site-builder.json" with { type: "json" };
import siteDeploy from "./site-deploy.json" with { type: "json" };

import { STEP_TOOLS } from "../steps.js";

// Every tool the two JSONs name — getRegistryTool must know them all or validatePipeline fails.
const KNOWN = new Set([
	"http_request", "slice", "flatten", "map", "web_search", "extract_contacts",
	"ai_generate", "parse_json", "mcp_call_tool", "create_ticket", "dedupe_upsert",
]);

const realHandler = (name: string) => STEP_TOOLS.find((t) => t.name === name)!.handler;

// ── the fixture business: a real-shaped Places details response ──────────────
const PLACE = {
	id: "ChIJ_kiosk",
	displayName: { text: "Palm Tree Kiosk" },
	formattedAddress: "12 Beach Rd, Bondi NSW 2026, Australia",
	shortFormattedAddress: "12 Beach Rd, Bondi",
	nationalPhoneNumber: "0298004444",
	googleMapsUri: "https://maps.google.com/?cid=99",
	rating: 4.6,
	userRatingCount: 212,
	editorialSummary: { text: "Casual beachfront kiosk for coffee and rolls." },
	regularOpeningHours: { weekdayDescriptions: ["Monday: 6:00 AM – 3:00 PM", "Tuesday: 6:00 AM – 3:00 PM"] },
	primaryTypeDisplayName: { text: "Cafe" },
	photos: [
		{ name: "places/ChIJ_kiosk/photos/AAA" },
		{ name: "places/ChIJ_kiosk/photos/BBB" },
		{ name: "places/ChIJ_kiosk/photos/CCC" },
		{ name: "places/ChIJ_kiosk/photos/DDD" },
		{ name: "places/ChIJ_kiosk/photos/EEE" },
		{ name: "places/ChIJ_kiosk/photos/FFF" },
	],
	addressComponents: [
		{ longText: "Bondi", types: ["locality", "political"] },
		{ longText: "New South Wales", types: ["administrative_area_level_1", "political"] },
		{ longText: "Australia", types: ["country", "political"] },
	],
};

/** What the LLM step returns — a JSON string inside a ```json fence, as models actually do. */
const MODEL_REPLY = [
	"```json",
	JSON.stringify({
		tagline: "Beachfront coffee and rolls at Bondi",
		meta_description: "Palm Tree Kiosk is a casual beachfront cafe in Bondi serving coffee and rolls.",
		about_html: "<p>Palm Tree Kiosk is a casual kiosk on Beach Rd in Bondi.</p>",
		services_html: "<ul><li>Coffee</li><li>Rolls</li><li>Cold drinks</li></ul>",
		gallery_html: '<div class="grid"><img src="https://lh3.example/AAA" alt="Palm Tree Kiosk" loading="lazy"></div>',
		hours_line: "Mon–Tue 6am–3pm",
		category: "cafe",
		slug: "palm-tree-kiosk-bondi",
	}),
	"```",
].join("\n");

// Recorders for the mocked boundaries.
let mcpCalls: Array<{ url: string; tool: string; args: Record<string, unknown> }> = [];
let tickets: Array<Record<string, unknown>> = [];
let upserted: Array<Record<string, unknown>> = [];
let photoRequests: string[] = [];
let searchQueries: string[] = [];
let aiPrompts: string[] = [];
/** What a MODEL reads: the fences are boundaries, not content. Strips the inline wrappers so the
 *  grounding assertions below still read as prose, while the fence itself is asserted separately. */
const readable = (t: string) =>
	t.replace(new RegExp(`<${FENCE_TAG} [^>]*>\\n[^\\n]*\\n\\n([\\s\\S]*?)\\n</${FENCE_TAG}>`, "g"), "$1");
let emits: Array<{ event: string; emitOn: string; payloads: Array<Record<string, unknown>> }> = [];

const runRegistryTool = vi.fn(async (name: string, ctx: unknown, input: Record<string, unknown>) => {
	// ── real pure transforms (the logic under test) ───────────────────────
	if (name === "map" || name === "slice" || name === "flatten" || name === "parse_json" || name === "extract_contacts") {
		const r = await realHandler(name)(ctx as never, input);
		return { name, content: r.content, success: r.success };
	}

	// ── mocked I/O ────────────────────────────────────────────────────────
	if (name === "http_request") {
		const url = String(input.url ?? "");
		if (url.includes("/media")) {
			// The photo-media lookup. skipHttpRedirect=true makes Places answer with JSON
			// carrying the public image URL, so the API key never reaches the built page.
			// http_request interpolates {{photo}} internally; mocking it means reading the
			// resolved value off `inputs` — which also proves the dotted-item plumbing worked.
			const photo = String((input.inputs as Record<string, unknown>)?.photo ?? "");
			photoRequests.push(photo);
			const key = photo.split("/photos/")[1] ?? "X";
			return { name, content: JSON.stringify({ status: 200, data: `https://lh3.example/${key}` }), success: true };
		}
		return { name, content: JSON.stringify({ status: 200, data: PLACE }), success: true };
	}
	if (name === "web_search") {
		searchQueries.push(String(input.query ?? ""));
		return {
			name,
			content: JSON.stringify({
				query: input.query,
				count: 2,
				results: [
					{ title: "Palm Tree Kiosk (@palmtreekiosk)", link: "https://www.instagram.com/palmtreekiosk/", snippet: "Bondi kiosk" },
					{ title: "Palm Tree Kiosk | Facebook", link: "https://www.facebook.com/palmtreekiosk", snippet: "hello@palmtree.example" },
				],
			}),
			success: true,
		};
	}
	if (name === "ai_generate") {
		const items = (Array.isArray(input.items) ? input.items : []) as Array<Record<string, unknown>>;
		aiPrompts.push(String(input.prompt ?? ""));
		const as = String(input.as ?? "text");
		// Render the prompt the way ai_generate REALLY does — the shared helper, fences and all
		// (#750). A private copy of the render would keep this test green while production drifted,
		// which is the whole reason the unfenced interpolation survived as long as it did.
		const rendered = renderWithFencedValues(String(input.prompt ?? ""), (k) =>
			k.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), items[0]),
		);
		aiPrompts[aiPrompts.length - 1] = rendered;
		return { name, content: JSON.stringify({ items: items.map((it) => ({ ...it, [as]: MODEL_REPLY })), count: items.length, generated: items.length }), success: true };
	}
	if (name === "mcp_call_tool") {
		const tool = String(input.tool ?? "");
		mcpCalls.push({ url: String(input.url ?? ""), tool, args: (input.args ?? {}) as Record<string, unknown> });
		if (tool === "create_site") return { name, content: JSON.stringify({ tool, ok: true, data: { session_id: "sess-42", template_slug: "neon-ai" } }), success: true };
		if (tool === "get_preview") return { name, content: JSON.stringify({ tool, ok: true, data: "<html>preview</html>" }), success: true };
		if (tool === "get_status") return { name, content: JSON.stringify({ tool, ok: true, data: { id: "palm-tree-kiosk-bondi", url: "https://palm-tree-kiosk-bondi.freewebstore.online", deployed: true } }), success: true };
		return { name, content: JSON.stringify({ tool, ok: true, data: { ok: true } }), success: true };
	}
	if (name === "create_ticket") {
		tickets.push(input);
		return { name, content: JSON.stringify({ ticketId: "t-1", status: "needs_approval", awaitingApproval: !!input.action }), success: true };
	}
	if (name === "dedupe_upsert") {
		const items = (Array.isArray(input.items) ? input.items : []) as Array<Record<string, unknown>>;
		emits.push({ event: String(input.emit ?? ""), emitOn: String(input.emitOn ?? "insert"), payloads: items });
		upserted.push(...items);
		return { name, content: JSON.stringify({ inserted: items.length, updated: 0, skipped: 0, total: items.length }), success: true };
	}
	return { name, content: `unexpected tool ${name}`, success: false };
});

vi.mock("../tool-registry.js", () => ({
	getRegistryTool: (name: string) => (KNOWN.has(name) ? { name } : undefined),
	runRegistryTool: (...args: unknown[]) => (runRegistryTool as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Import AFTER the mock so pipeline.ts + steps.ts bind the mocked runRegistryTool.
import { executePipelineStep, stepBind, validatePipeline, type PipelineDef } from "../pipeline.js";
import type { Env } from "../../types.js";

const env = {} as Env;
const ctx = { env, userId: "u1", instanceId: "i1" };
const PARAMS = {
	place_id: "ChIJ_kiosk",
	mcpUrl: "https://builder.example.com/mcp",
	templateSlug: "neon-ai",
	photoLimit: 4,
};

beforeEach(() => {
	runRegistryTool.mockClear();
	mcpCalls = [];
	tickets = [];
	upserted = [];
	photoRequests = [];
	searchQueries = [];
	aiPrompts = [];
	emits = [];
});

/** Drive a whole JSON pipeline through the real runner, exactly as the durable runner does. */
async function drivePipeline(def: PipelineDef, params: Record<string, unknown>) {
	const outputs: Record<string, unknown> = {};
	for (let i = 0; i < def.steps.length; i++) {
		const r = await executePipelineStep(ctx, def.steps[i], i, outputs, params);
		outputs[stepBind(def.steps[i], i)] = r.output;
	}
	return outputs;
}

describe("site-builder — shape", () => {
	it("validates against the real runner contract", () => {
		expect(validatePipeline(siteBuilder)).toBeNull();
		expect(validatePipeline(siteDeploy)).toBeNull();
	});

	it("names no website-builder host — the MCP endpoint is a param, so no store is a dependency", () => {
		// Store independence: the platform must not hardcode a sibling/third-party service.
		const json = JSON.stringify(siteBuilder) + JSON.stringify(siteDeploy);
		expect(json).not.toMatch(/freewebstore|proagentstore|freeappstore|freegamestore/i);
		expect((siteBuilder as unknown as PipelineDef).params?.mcpUrl).toBeTruthy();
		for (const step of (siteBuilder as unknown as PipelineDef).steps) {
			if (step.tool === "mcp_call_tool") expect(step.inputs?.url).toEqual({ $param: "mcpUrl" });
		}
	});

	it("writes into `sites` keyed by place_id — through dedupe_upsert, not through the sink", () => {
		// The declared sink is dead here, as it is in all three shipped definitions: the final step
		// persists, so `pipeline-run.ts` stands the sink down. Its `keyField` was never read by
		// anything (#632) — the key that matters is the one on the `dedupe_upsert` step.
		const builder = siteBuilder as unknown as PipelineDef;
		expect(builder.sink?.collection).toBe("sites");
		expect(builder.steps.at(-1)?.tool).toBe("dedupe_upsert");
		expect((siteDeploy as unknown as PipelineDef).sink?.collection).toBe("sites");
	});
});

describe("site-builder — the run", () => {
	it("looks up the lead, builds the site, and stops at a human gate", async () => {
		const outputs = await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);

		// The site was assembled in the right order on the caller's configured server.
		expect(mcpCalls.map((c) => c.tool)).toEqual([
			"create_site", "set_meta", "set_contact", "set_social",
			"add_section", "add_section", "add_section", "get_preview",
		]);
		expect(new Set(mcpCalls.map((c) => c.url))).toEqual(new Set(["https://builder.example.com/mcp"]));
		// Every call AFTER create_site threads the session id it handed back.
		for (const call of mcpCalls.slice(1)) expect(call.args.session_id).toBe("sess-42");

		// Nothing was deployed — the last builder step is the gate, not a deploy.
		expect(mcpCalls.some((c) => c.tool === "deploy")).toBe(false);
		expect(upserted[0]).toMatchObject({ place_id: "ChIJ_kiosk", site_status: "awaiting_approval", site_session_id: "sess-42" });
		void outputs;
	});

	it("the draft is noindex — a business that never asked for a site can't be indexed under its name", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		expect(mcpCalls.find((c) => c.tool === "set_meta")!.args.noindex).toBe(true);
	});

	it("caps photos at photoLimit and resolves each to a public URL (no API key in the page)", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		// 6 photos available, limit 4 → 4 media lookups, none of them the raw redirect form.
		expect(photoRequests).toHaveLength(4);
		for (const p of photoRequests) expect(p).toMatch(/^places\/ChIJ_kiosk\/photos\//);
		// The resolved public URLs reach the copy step (and the key stays server-side).
		expect(readable(aiPrompts[0])).toContain("https://lh3.example/AAA");
		expect(aiPrompts[0]).not.toMatch(/key=/);
	});

	it("composes the social search from the looked-up name AND suburb, then merges the profiles found", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		// $format built this from the Places response, not from a caller-supplied string.
		expect(searchQueries).toEqual(["Palm Tree Kiosk Bondi instagram facebook"]);
		const social = mcpCalls.find((c) => c.tool === "set_social")!;
		expect(social.args.instagram).toBe("https://instagram.com/palmtreekiosk");
		expect(social.args.facebook).toBe("https://facebook.com/palmtreekiosk");
	});

	it("grounds the copy prompt in scraped facts only", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		const prompt = readable(aiPrompts[0]);
		expect(prompt).toContain("Palm Tree Kiosk");
		expect(prompt).toContain("12 Beach Rd, Bondi NSW 2026, Australia");
		expect(prompt).toContain("Cafe");
		expect(prompt).toContain("4.6");
		expect(prompt).toContain("Monday: 6:00 AM – 3:00 PM");
		// The type-predicate extraction pulled the suburb out of Google's typed components.
		expect(prompt).toContain("Bondi, New South Wales");
	});

	it("parses the model's fenced JSON into the fields the builder calls use", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		const meta = mcpCalls.find((c) => c.tool === "set_meta")!;
		expect(meta.args.title).toBe("Palm Tree Kiosk");
		expect(meta.args.description).toMatch(/casual beachfront cafe in Bondi/);
		const sections = mcpCalls.filter((c) => c.tool === "add_section");
		expect(sections.map((s) => s.args.type)).toEqual(["about", "features", "gallery"]);
		expect(sections[0].args.content).toContain("<p>");
		expect(sections[2].args.content).toContain("https://lh3.example/AAA");
		expect(mcpCalls.find((c) => c.tool === "set_contact")!.args.hours).toBe("Mon–Tue 6am–3pm");
	});

	it("raises an approval ticket carrying the deploy as its action, with everything deploy needs", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		expect(tickets).toHaveLength(1);
		const t = tickets[0];
		expect(t.title).toBe("Deploy the site for Palm Tree Kiosk");
		expect(t.action).toBe("run_pipeline");
		expect(t.config).toEqual({ pipeline: "site-deploy" });
		expect(t.params).toMatchObject({
			session_id: "sess-42",
			place_id: "ChIJ_kiosk",
			mcpUrl: "https://builder.example.com/mcp",
			slug: "palm-tree-kiosk-bondi",
			category: "cafe",
		});
		// The reasoning tells the approver what they're actually approving.
		expect(String(t.reasoning)).toMatch(/noindex/);
	});

	it("stores the lead's contact details on the site record so outreach can use them", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		expect(upserted[0]).toMatchObject({
			name: "Palm Tree Kiosk",
			phone: "0298004444",
			suburb: "Bondi",
			email: "hello@palmtree.example",
			instagram: "https://instagram.com/palmtreekiosk",
		});
	});

	it("survives a business with no photos, no socials and no editorial summary", async () => {
		// The thin-lead case: most no-website businesses ARE thin. It must still build.
		const thin = { ...PLACE, photos: [], editorialSummary: undefined, rating: undefined, userRatingCount: undefined };
		runRegistryTool.mockImplementationOnce(async (name: string, _c: unknown, _i: Record<string, unknown>) => ({
			name,
			content: JSON.stringify({ status: 200, data: thin }),
			success: true,
		}));
		const outputs = await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		expect(photoRequests).toHaveLength(0);
		expect(mcpCalls.map((c) => c.tool)).toContain("create_site");
		expect(tickets).toHaveLength(1);
		void outputs;
	});
});

describe("site-deploy — the approved half", () => {
	it("deploys the built session and writes the live URL back onto the record", async () => {
		const outputs = await drivePipeline(siteDeploy as unknown as PipelineDef, {
			session_id: "sess-42",
			place_id: "ChIJ_kiosk",
			mcpUrl: "https://builder.example.com/mcp",
			slug: "palm-tree-kiosk-bondi",
			name: "Palm Tree Kiosk",
			category: "cafe",
			description: "A casual beachfront cafe in Bondi.",
		});

		const deploy = mcpCalls.find((c) => c.tool === "deploy")!;
		expect(deploy.args).toMatchObject({ session_id: "sess-42", id: "palm-tree-kiosk-bondi", name: "Palm Tree Kiosk", category: "cafe" });
		expect(upserted[0]).toMatchObject({
			place_id: "ChIJ_kiosk",
			site_status: "live",
			site_url: "https://palm-tree-kiosk-bondi.freewebstore.online",
			site_slug: "palm-tree-kiosk-bondi",
		});
		void outputs;
	});

	it("is the ONLY pipeline that deploys — the builder can never reach it on its own", () => {
		const builderTools = (siteBuilder as unknown as PipelineDef).steps
			.filter((s) => s.tool === "mcp_call_tool")
			.map((s) => (s.inputs as Record<string, { toString(): string }>).tool);
		expect(builderTools).not.toContain("deploy");
		expect(builderTools).not.toContain("push_update");
	});
});

// ── the chain: Lead Finder → Site Builder → [approve] → deploy → Outreach ──────────────
describe("the agent chain — what the next agent is handed", () => {
	it("the ticket carries everything site-deploy needs, including the pitch details", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		// The ticket is the ONLY carrier across the human gate: a field missing here is a
		// field the outreach pitch can never mention.
		expect(tickets[0].params).toMatchObject({
			session_id: "sess-42",
			place_id: "ChIJ_kiosk",
			slug: "palm-tree-kiosk-bondi",
			name: "Palm Tree Kiosk",
			suburb: "Bondi",
			address: "12 Beach Rd, Bondi NSW 2026, Australia",
			phone: "0298004444",
			email: "hello@palmtree.example",
		});
	});

	it("the builder announces a DRAFT, and only on a net-new record", async () => {
		await drivePipeline(siteBuilder as unknown as PipelineDef, PARAMS);
		expect(emits.at(-1)).toMatchObject({ event: "site.drafted", emitOn: "insert" });
	});

	it("the deploy announces site.live on UPDATE — the record already exists, so insert-only would never fire", async () => {
		await drivePipeline(siteDeploy as unknown as PipelineDef, {
			session_id: "sess-42", place_id: "ChIJ_kiosk", mcpUrl: "https://builder.example.com/mcp",
			slug: "palm-tree-kiosk-bondi", name: "Palm Tree Kiosk", category: "cafe",
			description: "A casual beachfront cafe in Bondi.",
			suburb: "Bondi", address: "12 Beach Rd, Bondi NSW 2026, Australia",
			phone: "0298004444", email: "hello@palmtree.example",
		});
		const emitted = emits.at(-1)!;
		expect(emitted.event).toBe("site.live");
		expect(emitted.emitOn).toBe("both"); // site-builder inserted this record; deploy updates it
		// The payload has to stand on its own — the outreach agent gets ONLY this.
		expect(emitted.payloads[0]).toMatchObject({
			place_id: "ChIJ_kiosk",
			name: "Palm Tree Kiosk",
			suburb: "Bondi",
			phone: "0298004444",
			email: "hello@palmtree.example",
			site_url: "https://palm-tree-kiosk-bondi.freewebstore.online",
			site_status: "live",
		});
	});
});
