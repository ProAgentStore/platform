import { Hono } from "hono";
import type { Context } from "hono";
import {
	type ApplicationDraft,
	type CandidateProfile,
	type JobPage,
	buildApplicationPrompt,
	buildFallbackDraft,
	buildSubmissionPlan,
	buildSubmissionRequest,
	extractJobPage,
	normalizeProfile,
	parseAiDraft,
	validateJobUrl,
	validateProfile,
} from "./lib.js";

interface Env {
	AI: Ai;
	APPLICATIONS: DurableObjectNamespace;
	API_SECRET?: string;
}

interface ApplicationCreateRequest {
	jobUrl: string;
	profile?: Partial<CandidateProfile>;
	answers?: Record<string, string>;
}

interface ApplicationRecord {
	id: string;
	jobUrl: string;
	status: "ready_for_review" | "blocked" | "submitted";
	profile: CandidateProfile;
	job: JobPage;
	draft: ApplicationDraft;
	answers: Record<string, string>;
	submission: ReturnType<typeof buildSubmissionPlan>;
	createdAt: string;
	updatedAt: string;
	submittedAt?: string;
	submissionResponse?: {
		status: number;
		ok: boolean;
		url: string;
	};
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0];
const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
	const secret = c.env.API_SECRET;
	if (!secret) return next();
	const auth = c.req.header("authorization") || "";
	if (auth !== `Bearer ${secret}`) return c.json({ error: "Unauthorized" }, 401);
	return next();
});

app.get("/", (c) =>
	c.json({
		agent: "job-application-assistant",
		type: "agent",
		status: "ok",
		model: MODEL,
		safety: "Prepares application packets first; external submission requires explicit confirmation.",
		endpoints: [
			"GET /profile",
			"PUT /profile",
			"POST /applications",
			"POST /run",
			"GET /applications",
			"GET /applications/:id",
			"POST /applications/:id/submit",
		],
	}),
);

app.get("/profile", async (c) => proxyStore(c.env, "/profile"));

app.put("/profile", async (c) => {
	const body = await c.req.json<Partial<CandidateProfile>>().catch(() => null);
	if (!body) return c.json({ error: "Invalid JSON body" }, 400);
	const profile = normalizeProfile(body);
	const errors = validateProfile(profile);
	if (errors.length) return c.json({ error: "Invalid profile", details: errors }, 400);
	return proxyStore(c.env, "/profile", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(profile),
	});
});

app.post("/run", async (c) => createApplication(c));
app.post("/applications", async (c) => createApplication(c));

app.get("/applications", async (c) => proxyStore(c.env, "/applications"));
app.get("/applications/:id", async (c) =>
	proxyStore(c.env, `/applications/${encodeURIComponent(c.req.param("id"))}`),
);

app.post("/applications/:id/submit", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json<{ confirmation?: string }>().catch(() => ({}))) as {
		confirmation?: string;
	};
	const recordRes = await store(c.env).fetch(new Request(`http://store/applications/${id}`));
	if (!recordRes.ok) return new Response(recordRes.body, { status: recordRes.status, headers: recordRes.headers });
	const record = await recordRes.json<ApplicationRecord>();

	let submission: ReturnType<typeof buildSubmissionRequest>;
	try {
		submission = buildSubmissionRequest(
			record.job.url,
			record.submission,
			body.confirmation || "",
		);
	} catch (error) {
		return c.json(
			{
				error: "submission_not_ready",
				message: error instanceof Error ? error.message : "Application is not ready.",
				submission: record.submission,
			},
			409,
		);
	}

	const res = await fetch(submission.url, submission.init);
	const updated: ApplicationRecord = {
		...record,
		status: res.ok ? "submitted" : "blocked",
		updatedAt: new Date().toISOString(),
		submittedAt: res.ok ? new Date().toISOString() : record.submittedAt,
		submissionResponse: {
			status: res.status,
			ok: res.ok,
			url: res.url || submission.url,
		},
	};
	await store(c.env).fetch(new Request(`http://store/applications/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updated),
	}));

	return c.json({
		id,
		status: updated.status,
		response: updated.submissionResponse,
		fieldsSubmitted: Object.keys(submission.fields),
	});
});

async function createApplication(c: Context<{ Bindings: Env }>) {
	const body = await c.req.json<ApplicationCreateRequest>().catch(() => null);
	if (!body) return c.json({ error: "Invalid JSON body" }, 400);

	let jobUrl: string;
	try {
		jobUrl = validateJobUrl(body.jobUrl);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Invalid jobUrl" }, 400);
	}

	const savedProfileRes = await store(c.env).fetch(new Request("http://store/profile"));
	const savedProfile = savedProfileRes.ok
		? await savedProfileRes.json<Partial<CandidateProfile>>()
		: {};
	const profile = normalizeProfile({ ...savedProfile, ...body.profile });
	const profileErrors = validateProfile(profile);
	if (profileErrors.length) {
		return c.json({ error: "Invalid profile", details: profileErrors }, 400);
	}

	const htmlRes = await fetch(jobUrl, {
		headers: {
			"User-Agent": "ProAgentStore Job Application Assistant/0.1",
			Accept: "text/html,application/xhtml+xml",
		},
	});
	if (!htmlRes.ok) {
		return c.json({ error: "Failed to fetch job URL", status: htmlRes.status }, 502);
	}
	const html = await htmlRes.text();
	const job = extractJobPage(html, jobUrl);
	const answers = Object.fromEntries(
		Object.entries(body.answers || {}).map(([key, value]) => [key, String(value).slice(0, 2_000)]),
	);
	const fallback = buildFallbackDraft(job, profile, answers);
	const draft = await generateDraft(c.env, job, profile, answers, fallback);
	const id = `app_${crypto.randomUUID()}`;
	const submission = buildSubmissionPlan(id, job, profile, draft, answers);
	const now = new Date().toISOString();
	const record: ApplicationRecord = {
		id,
		jobUrl,
		status: submission.ready ? "ready_for_review" : "blocked",
		profile,
		job,
		draft,
		answers,
		submission,
		createdAt: now,
		updatedAt: now,
	};

	const saveRes = await store(c.env).fetch(new Request("http://store/applications", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(record),
	}));
	if (!saveRes.ok) return c.json({ error: "Failed to save application" }, 500);
	return c.json(record, 201);
}

async function generateDraft(
	env: Env,
	job: JobPage,
	profile: CandidateProfile,
	answers: Record<string, string>,
	fallback: ApplicationDraft,
): Promise<ApplicationDraft> {
	try {
		const result = await env.AI.run(MODEL, {
			messages: [
				{
					role: "system",
					content:
						"You are a careful job application assistant. You prepare truthful application material and never invent facts.",
				},
				{ role: "user", content: buildApplicationPrompt(job, profile, answers) },
			],
		});
		return parseAiDraft(result, fallback);
	} catch {
		return fallback;
	}
}

function store(env: Env): DurableObjectStub {
	return env.APPLICATIONS.get(env.APPLICATIONS.idFromName("store"));
}

function proxyStore(env: Env, path: string, init?: RequestInit): Promise<Response> {
	return store(env).fetch(new Request(`http://store${path}`, init));
}

export class ApplicationStoreDO {
	constructor(private state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/profile") {
			if (request.method === "GET") {
				return Response.json((await this.state.storage.get("profile")) || {});
			}
			if (request.method === "PUT") {
				const profile = await request.json<CandidateProfile>();
				await this.state.storage.put("profile", profile);
				return Response.json(profile);
			}
		}

		if (path === "/applications" && request.method === "GET") {
			const rows = await this.state.storage.list<ApplicationRecord>({
				prefix: "application:",
				reverse: true,
				limit: 50,
			});
			return Response.json({ applications: [...rows.values()] });
		}

		if (path === "/applications" && request.method === "POST") {
			const record = await request.json<ApplicationRecord>();
			await this.state.storage.put(`application:${record.id}`, record);
			return Response.json({ id: record.id }, { status: 201 });
		}

		const match = path.match(/^\/applications\/([^/]+)$/);
		if (match) {
			const id = decodeURIComponent(match[1]);
			const key = `application:${id}`;
			if (request.method === "GET") {
				const record = await this.state.storage.get<ApplicationRecord>(key);
				return record ? Response.json(record) : Response.json({ error: "Not found" }, { status: 404 });
			}
			if (request.method === "PUT") {
				const record = await request.json<ApplicationRecord>();
				await this.state.storage.put(key, record);
				return Response.json({ id });
			}
		}

		return new Response("Not found", { status: 404 });
	}
}

export default app;
