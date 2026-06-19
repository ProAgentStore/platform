export interface CandidateProfile {
	fullName: string;
	email: string;
	phone?: string;
	location?: string;
	linkedin?: string;
	portfolio?: string;
	resumeText?: string;
	coverLetterStyle?: string;
	workAuthorization?: string;
	salaryExpectations?: string;
	noticePeriod?: string;
	extra?: Record<string, string>;
}

export interface FormField {
	name: string;
	type: string;
	label: string;
	required: boolean;
}

export interface JobForm {
	action: string;
	method: "get" | "post";
	fields: FormField[];
	score: number;
}

export interface JobPage {
	url: string;
	title: string;
	company: string;
	descriptionText: string;
	applyUrl: string;
	forms: JobForm[];
	blockers: string[];
}

export interface ApplicationDraft {
	coverLetter: string;
	shortPitch: string;
	answers: Record<string, string>;
	resumeHighlights: string[];
}

export interface SubmissionPlan {
	ready: boolean;
	requiresConfirmation: true;
	confirmationPhrase: string;
	form?: JobForm;
	blockers: string[];
	mappedFields: Record<string, string>;
}

export interface SubmissionRequest {
	url: string;
	init: RequestInit;
	fields: Record<string, string>;
}

const BLOCKED_FIELD_TYPES = new Set(["file", "password"]);
const MAX_TEXT = 12_000;

export function normalizeProfile(input: Partial<CandidateProfile> | undefined): CandidateProfile {
	const profile = input || {};
	return {
		fullName: clean(profile.fullName),
		email: clean(profile.email),
		phone: optional(profile.phone),
		location: optional(profile.location),
		linkedin: optional(profile.linkedin),
		portfolio: optional(profile.portfolio),
		resumeText: optional(profile.resumeText, 8_000),
		coverLetterStyle: optional(profile.coverLetterStyle, 800),
		workAuthorization: optional(profile.workAuthorization, 500),
		salaryExpectations: optional(profile.salaryExpectations, 300),
		noticePeriod: optional(profile.noticePeriod, 300),
		extra: cleanRecord(profile.extra),
	};
}

export function validateProfile(profile: CandidateProfile): string[] {
	const errors: string[] = [];
	if (!profile.fullName) errors.push("profile.fullName is required");
	if (!profile.email) errors.push("profile.email is required");
	if (profile.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.email)) {
		errors.push("profile.email must be a valid email address");
	}
	return errors;
}

export function validateJobUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("jobUrl must be a valid URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("jobUrl must use http or https");
	}
	return url.toString();
}

export function extractJobPage(html: string, jobUrl: string): JobPage {
	const base = validateJobUrl(jobUrl);
	const text = stripHtml(html).slice(0, MAX_TEXT);
	const title =
		meta(html, "og:title") ||
		tagText(html, "h1") ||
		tagText(html, "title") ||
		"Untitled job";
	const company =
		meta(html, "og:site_name") ||
		valueNearLabel(text, ["company", "employer", "organization"]) ||
		"Unknown company";
	const applyUrl = findApplyUrl(html, base);
	const forms = extractForms(html, base);
	const blockers = detectPageBlockers(html, forms);

	return {
		url: base,
		title: normalizeWhitespace(title).slice(0, 160),
		company: normalizeWhitespace(company).slice(0, 120),
		descriptionText: text,
		applyUrl,
		forms,
		blockers,
	};
}

export function buildFallbackDraft(
	job: JobPage,
	profile: CandidateProfile,
	answers: Record<string, string> = {},
): ApplicationDraft {
	const highlights = resumeHighlights(profile.resumeText || "");
	const name = profile.fullName || "Candidate";
	const role = job.title || "the role";
	const company = job.company || "your team";
	const style = profile.coverLetterStyle ? ` ${profile.coverLetterStyle}` : "";
	return {
		coverLetter: [
			`Dear ${company} hiring team,`,
			"",
			`I am applying for ${role}. My background is a strong match for the work described in the posting, and I am interested in contributing to ${company}.${style}`,
			"",
			highlights.length
				? `Relevant highlights include ${joinSentence(highlights)}.`
				: "I can bring focused execution, clear communication, and practical problem solving to this role.",
			"",
			`Thank you for considering my application.`,
			"",
			name,
		].join("\n"),
		shortPitch: `${name} is a strong candidate for ${role}, with relevant experience and a profile tailored to ${company}.`,
		answers: {
			"Why are you interested in this role?": `The ${role} opportunity at ${company} matches my experience and the kind of impact I want to make.`,
			...answers,
		},
		resumeHighlights: highlights,
	};
}

export function buildApplicationPrompt(
	job: JobPage,
	profile: CandidateProfile,
	answers: Record<string, string>,
): string {
	return JSON.stringify({
		task: "Create a truthful job application packet.",
		output: {
			coverLetter: "string",
			shortPitch: "string",
			answers: "object of likely application question answers",
			resumeHighlights: "array of 3-5 concise strings",
		},
		rules: [
			"Do not invent credentials, employment history, education, certifications, or work authorization.",
			"Use only the candidate profile and job posting text.",
			"Keep the cover letter under 350 words.",
			"Return only JSON.",
		],
		job: {
			url: job.url,
			title: job.title,
			company: job.company,
			descriptionText: job.descriptionText.slice(0, 7_000),
		},
		candidate: profile,
		callerAnswers: answers,
	});
}

export function parseAiDraft(value: unknown, fallback: ApplicationDraft): ApplicationDraft {
	const raw =
		typeof value === "object" && value && "response" in value
			? (value as { response?: unknown }).response
			: value;
	const text = typeof raw === "string" ? raw : JSON.stringify(raw || {});
	const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
	try {
		const parsed = JSON.parse(jsonText) as Partial<ApplicationDraft>;
		return {
			coverLetter: clean(parsed.coverLetter, 5_000) || fallback.coverLetter,
			shortPitch: clean(parsed.shortPitch, 1_000) || fallback.shortPitch,
			answers: { ...fallback.answers, ...cleanRecord(parsed.answers) },
			resumeHighlights: Array.isArray(parsed.resumeHighlights)
				? parsed.resumeHighlights.map((item) => clean(item, 300)).filter(Boolean).slice(0, 5)
				: fallback.resumeHighlights,
		};
	} catch {
		return fallback;
	}
}

export function buildSubmissionPlan(
	applicationId: string,
	job: JobPage,
	profile: CandidateProfile,
	draft: ApplicationDraft,
	answers: Record<string, string>,
): SubmissionPlan {
	const form = selectApplicationForm(job.forms);
	const blockers = [...job.blockers];
	if (!form) blockers.push("No safe application form was detected on the job page.");
	const mappedFields = form ? mapProfileToFields(form.fields, profile, draft, answers) : {};
	if (form && Object.keys(mappedFields).length < Math.min(2, form.fields.length)) {
		blockers.push("Detected form fields could not be mapped confidently from the candidate profile.");
	}
	return {
		ready: Boolean(form) && blockers.length === 0,
		requiresConfirmation: true,
		confirmationPhrase: `submit ${applicationId}`,
		form,
		blockers: unique(blockers),
		mappedFields,
	};
}

export function buildSubmissionRequest(
	pageUrl: string,
	plan: SubmissionPlan,
	confirmation: string,
): SubmissionRequest {
	if (confirmation !== plan.confirmationPhrase) {
		throw new Error(`confirmation must exactly equal "${plan.confirmationPhrase}"`);
	}
	if (!plan.ready || !plan.form) {
		throw new Error(plan.blockers[0] || "application is not ready for automatic submission");
	}
	const targetUrl = absoluteUrl(plan.form.action || pageUrl, pageUrl);
	const body = new URLSearchParams(plan.mappedFields);
	if (plan.form.method === "get") {
		const url = new URL(targetUrl);
		for (const [key, value] of body.entries()) url.searchParams.set(key, value);
		return { url: url.toString(), init: { method: "GET" }, fields: plan.mappedFields };
	}
	return {
		url: targetUrl,
		init: {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		},
		fields: plan.mappedFields,
	};
}

export function mapProfileToFields(
	fields: FormField[],
	profile: CandidateProfile,
	draft: ApplicationDraft,
	answers: Record<string, string>,
): Record<string, string> {
	const [firstName, ...rest] = profile.fullName.split(/\s+/).filter(Boolean);
	const lastName = rest.join(" ");
	const mapped: Record<string, string> = {};
	for (const field of fields) {
		if (!field.name || field.type === "hidden" || BLOCKED_FIELD_TYPES.has(field.type)) continue;
		const key = `${field.name} ${field.label}`.toLowerCase();
		const answer = answerForField(key, answers);
		const value =
			answer ||
			(key.includes("first") && firstName) ||
			(key.includes("last") && lastName) ||
			(nameLike(key) && profile.fullName) ||
			(key.includes("email") && profile.email) ||
			((key.includes("phone") || key.includes("mobile")) && profile.phone) ||
			((key.includes("linkedin") || key.includes("linked in")) && profile.linkedin) ||
			((key.includes("portfolio") || key.includes("website")) && profile.portfolio) ||
			(key.includes("location") && profile.location) ||
			((key.includes("authorization") || key.includes("eligible")) && profile.workAuthorization) ||
			(key.includes("salary") && profile.salaryExpectations) ||
			(key.includes("notice") && profile.noticePeriod) ||
			((key.includes("cover") || key.includes("message") || key.includes("why")) && draft.coverLetter) ||
			((key.includes("resume") || key.includes("cv")) && (profile.resumeText || draft.shortPitch)) ||
			(profile.extra ? answerForField(key, profile.extra) : "");
		if (value) mapped[field.name] = value;
	}
	return mapped;
}

export function extractForms(html: string, pageUrl: string): JobForm[] {
	const forms: JobForm[] = [];
	for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
		const attrs = match[1] || "";
		const inner = match[2] || "";
		const method = attr(attrs, "method").toLowerCase() === "get" ? "get" : "post";
		const action = attr(attrs, "action") || pageUrl;
		const fields = extractFields(inner);
		const searchable = `${attrs} ${inner}`.toLowerCase();
		const score =
			(searchable.includes("apply") ? 4 : 0) +
			(searchable.includes("resume") || searchable.includes("cv") ? 3 : 0) +
			(searchable.includes("email") ? 1 : 0) +
			(searchable.includes("cover") ? 1 : 0) +
			fields.length;
		forms.push({ action: absoluteUrl(action, pageUrl), method, fields, score });
	}
	return forms.sort((a, b) => b.score - a.score);
}

export function selectApplicationForm(forms: JobForm[]): JobForm | undefined {
	return forms.find((form) => detectFormBlockers(form).length === 0);
}

export function detectPageBlockers(html: string, forms: JobForm[]): string[] {
	const lower = html.toLowerCase();
	const blockers: string[] = [];
	if (lower.includes("recaptcha") || lower.includes("g-recaptcha") || lower.includes("hcaptcha")) {
		blockers.push("Captcha detected.");
	}
	if (lower.includes("sign in") || lower.includes("log in") || lower.includes("create account")) {
		blockers.push("Login or account creation may be required.");
	}
	for (const form of forms) blockers.push(...detectFormBlockers(form));
	return unique(blockers);
}

export function detectFormBlockers(form: JobForm): string[] {
	const blockers: string[] = [];
	if (form.fields.some((field) => field.type === "file")) {
		blockers.push("File upload fields require manual review.");
	}
	if (form.fields.some((field) => field.type === "password")) {
		blockers.push("Password fields require manual review.");
	}
	if (form.fields.some((field) => /captcha|recaptcha|hcaptcha/i.test(`${field.name} ${field.label}`))) {
		blockers.push("Captcha fields require manual review.");
	}
	if (form.fields.length === 0) blockers.push("Form has no named fields.");
	return unique(blockers);
}

export function stripHtml(html: string): string {
	return normalizeWhitespace(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|li|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&#39;/g, "'")
			.replace(/&quot;/g, '"'),
	);
}

function extractFields(html: string): FormField[] {
	const fields: FormField[] = [];
	for (const match of html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
		const tag = match[1].toLowerCase();
		const attrs = match[2] || "";
		const name = attr(attrs, "name");
		if (!name) continue;
		const type = tag === "input" ? attr(attrs, "type").toLowerCase() || "text" : tag;
		fields.push({
			name,
			type,
			label: attr(attrs, "aria-label") || attr(attrs, "placeholder") || name,
			required: /\brequired\b/i.test(attrs),
		});
	}
	return fields;
}

function findApplyUrl(html: string, baseUrl: string): string {
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const label = stripHtml(match[2] || "").toLowerCase();
		const href = attr(match[1] || "", "href");
		if (href && /apply|application|submit/.test(label + " " + href.toLowerCase())) {
			return absoluteUrl(href, baseUrl);
		}
	}
	return baseUrl;
}

function meta(html: string, key: string): string {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`<meta\\b([^>]*(?:property|name)=["']${escaped}["'][^>]*)>`, "i");
	const match = html.match(re);
	return match ? attr(match[1], "content") : "";
}

function tagText(html: string, tag: string): string {
	const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
	return match ? stripHtml(match[1]) : "";
}

function valueNearLabel(text: string, labels: string[]): string {
	for (const label of labels) {
		const re = new RegExp(`${label}\\s*:?\\s*([^\\n|•]{2,80})`, "i");
		const match = text.match(re);
		if (match) return match[1].trim();
	}
	return "";
}

function attr(attrs: string, name: string): string {
	const re = new RegExp(`${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
	const match = attrs.match(re);
	if (!match) return "";
	return match[1].replace(/^['"]|['"]$/g, "").trim();
}

function answerForField(key: string, answers: Record<string, string>): string {
	for (const [answerKey, answerValue] of Object.entries(answers)) {
		if (key.includes(answerKey.toLowerCase())) return answerValue;
	}
	return "";
}

function nameLike(key: string): boolean {
	const normalized = key.replace(/[_-]+/g, " ");
	return (normalized.includes("full name") || /\bname\b/.test(normalized)) && !normalized.includes("company");
}

function resumeHighlights(resumeText: string): string[] {
	return resumeText
		.split(/[\n.;]+/)
		.map((line) => clean(line, 180))
		.filter((line) => line.length > 35)
		.slice(0, 4);
}

function joinSentence(parts: string[]): string {
	if (parts.length <= 1) return parts[0] || "";
	return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function absoluteUrl(value: string, base: string): string {
	return new URL(value || base, base).toString();
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clean(value: unknown, max = 1_000): string {
	return String(value || "").replace(/\0/g, "").trim().slice(0, max);
}

function optional(value: unknown, max = 1_000): string | undefined {
	const cleaned = clean(value, max);
	return cleaned || undefined;
}

function cleanRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.map(([key, item]) => [clean(key, 100), clean(item, 2_000)])
			.filter(([key, item]) => key && item),
	);
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
