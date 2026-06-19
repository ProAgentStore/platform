import { describe, expect, it } from "vitest";
import {
	buildFallbackDraft,
	buildSubmissionPlan,
	buildSubmissionRequest,
	extractJobPage,
	mapProfileToFields,
	normalizeProfile,
	validateJobUrl,
	validateProfile,
} from "./lib.js";

const profile = normalizeProfile({
	fullName: "Sam Candidate",
	email: "sam@example.com",
	phone: "+1 555 0100",
	linkedin: "https://linkedin.com/in/sam",
	portfolio: "https://sam.dev",
	location: "Remote",
	resumeText:
		"Built distributed TypeScript systems for high-volume workflow automation. Led product engineering teams shipping customer-facing tools. Improved application conversion with structured experiments.",
	workAuthorization: "Authorized to work in the United States.",
	salaryExpectations: "$180k target total compensation.",
});

describe("job URL and profile validation", () => {
	it("accepts http and https job URLs only", () => {
		expect(validateJobUrl("https://example.com/jobs/1")).toBe("https://example.com/jobs/1");
		expect(() => validateJobUrl("ftp://example.com/jobs/1")).toThrow("http or https");
		expect(() => validateJobUrl("not a url")).toThrow("valid URL");
	});

	it("requires candidate name and valid email", () => {
		expect(validateProfile(profile)).toEqual([]);
		expect(validateProfile(normalizeProfile({ email: "bad" }))).toEqual([
			"profile.fullName is required",
			"profile.email must be a valid email address",
		]);
	});
});

describe("job page extraction", () => {
	it("extracts title, company, apply link, form fields, and text", () => {
		const job = extractJobPage(
			`<!doctype html>
			<title>Senior Product Engineer</title>
			<meta property="og:site_name" content="Acme">
			<h1>Senior Product Engineer</h1>
			<p>Build customer-facing workflow systems.</p>
			<a href="/apply">Apply now</a>
			<form action="/apply" method="post">
				<input name="full_name" placeholder="Full name" required>
				<input name="email" type="email" required>
				<textarea name="cover_letter" placeholder="Cover letter"></textarea>
			</form>`,
			"https://jobs.example.com/roles/123",
		);

		expect(job.title).toBe("Senior Product Engineer");
		expect(job.company).toBe("Acme");
		expect(job.applyUrl).toBe("https://jobs.example.com/apply");
		expect(job.forms[0].action).toBe("https://jobs.example.com/apply");
		expect(job.forms[0].fields.map((field) => field.name)).toEqual([
			"full_name",
			"email",
			"cover_letter",
		]);
		expect(job.descriptionText).toContain("Build customer-facing workflow systems");
	});

	it("flags blockers for captcha, login, file upload, and password fields", () => {
		const job = extractJobPage(
			`<h1>Role</h1>
			<p>Please sign in and complete recaptcha.</p>
			<form><input name="resume" type="file"><input name="password" type="password"></form>`,
			"https://example.com/job",
		);

		expect(job.blockers).toContain("Captcha detected.");
		expect(job.blockers).toContain("Login or account creation may be required.");
		expect(job.blockers).toContain("File upload fields require manual review.");
		expect(job.blockers).toContain("Password fields require manual review.");
	});
});

describe("application preparation and submission planning", () => {
	it("maps candidate fields into a safe application form", () => {
		const job = extractJobPage(
			`<h1>Senior Product Engineer</h1>
			<form action="/apply" method="post">
				<input name="first_name" placeholder="First name">
				<input name="last_name" placeholder="Last name">
				<input name="email" type="email">
				<input name="linkedin" placeholder="LinkedIn">
				<textarea name="why_this_role" placeholder="Why this role?"></textarea>
			</form>`,
			"https://jobs.example.com/roles/123",
		);
		const draft = buildFallbackDraft(job, profile);

		expect(mapProfileToFields(job.forms[0].fields, profile, draft, {})).toMatchObject({
			first_name: "Sam",
			last_name: "Candidate",
			email: "sam@example.com",
			linkedin: "https://linkedin.com/in/sam",
			why_this_role: draft.coverLetter,
		});
	});

	it("requires exact confirmation before building a submission request", () => {
		const job = extractJobPage(
			`<h1>Senior Product Engineer</h1>
			<form action="/apply" method="post">
				<input name="full_name">
				<input name="email">
			</form>`,
			"https://jobs.example.com/roles/123",
		);
		const draft = buildFallbackDraft(job, profile);
		const plan = buildSubmissionPlan("app_123", job, profile, draft, {});

		expect(plan.ready).toBe(true);
		expect(plan.confirmationPhrase).toBe("submit app_123");
		expect(() => buildSubmissionRequest(job.url, plan, "yes")).toThrow("confirmation");
		const request = buildSubmissionRequest(job.url, plan, "submit app_123");
		expect(request.url).toBe("https://jobs.example.com/apply");
		expect(request.init.method).toBe("POST");
		expect(request.fields).toMatchObject({
			full_name: "Sam Candidate",
			email: "sam@example.com",
		});
	});

	it("blocks automatic submission when only unsafe forms are present", () => {
		const job = extractJobPage(
			`<h1>Senior Product Engineer</h1><form action="/apply"><input name="resume" type="file"></form>`,
			"https://jobs.example.com/roles/123",
		);
		const draft = buildFallbackDraft(job, profile);
		const plan = buildSubmissionPlan("app_123", job, profile, draft, {});

		expect(plan.ready).toBe(false);
		expect(plan.blockers).toContain("File upload fields require manual review.");
		expect(() => buildSubmissionRequest(job.url, plan, "submit app_123")).toThrow(
			"File upload",
		);
	});
});
