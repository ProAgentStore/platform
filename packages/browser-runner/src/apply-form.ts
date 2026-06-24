import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { humanApproach } from "./human-mouse.js";
import { RunnerInputError } from "./errors.js";

/**
 * Legacy, deterministic selector-based job-application helpers used by the
 * `job.apply_basic` / `job.apply_authenticated` task types. The LLM-driven
 * `job.apply_agent` flow (a remote Cloudflare Workflow driving the runner's
 * /browser/* endpoints) supersedes these for real ATS; they remain for simple
 * single-page forms and their tests.
 */

export interface JobApplicationInput {
	url: string;
	resumePath: string;
	candidate: {
		fullName: string;
		email: string;
		phone?: string;
		location?: string;
		linkedin?: string;
		portfolio?: string;
		workAuthorization?: string;
	};
	coverNote?: string;
}

export interface AuthenticatedJobInput extends JobApplicationInput {
	/** Site credentials — if the job board requires login */
	credentials?: {
		email: string;
		password: string;
	};
	/** URL to the login page (auto-detected if not provided) */
	loginUrl?: string;
	/** Skip registration and assume account exists */
	accountExists?: boolean;
	/** Registration details if account needs to be created */
	registration?: {
		fullName: string;
		email: string;
		password: string;
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
	return String(value || "").trim();
}

export function optionalString(value: unknown): string | undefined {
	const text = stringValue(value);
	return text || undefined;
}

export function normalizeJobApplicationInput(input: Record<string, unknown>): JobApplicationInput {
	const url = stringValue(input.url);
	if (!url || !/^https?:\/\//.test(url)) {
		throw new RunnerInputError("job application requires an http(s) url");
	}
	const resumePath = resolve(stringValue(input.resumePath));
	if (!resumePath || !existsSync(resumePath)) {
		throw new RunnerInputError("job application requires an existing local resumePath");
	}
	const candidate = isRecord(input.candidate) ? input.candidate : {};
	const fullName = stringValue(candidate.fullName);
	const email = stringValue(candidate.email);
	if (!fullName) throw new RunnerInputError("candidate.fullName is required");
	if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		throw new RunnerInputError("candidate.email must be a valid email address");
	}
	return {
		url,
		resumePath,
		candidate: {
			fullName,
			email,
			phone: optionalString(candidate.phone),
			location: optionalString(candidate.location),
			linkedin: optionalString(candidate.linkedin),
			portfolio: optionalString(candidate.portfolio),
			workAuthorization: optionalString(candidate.workAuthorization),
		},
		coverNote: optionalString(input.coverNote),
	};
}

export function normalizeAuthenticatedJobInput(input: Record<string, unknown>): AuthenticatedJobInput {
	const base = normalizeJobApplicationInput(input);
	const credentials = isRecord(input.credentials) ? input.credentials : undefined;
	const registration = isRecord(input.registration) ? input.registration : undefined;

	return {
		...base,
		credentials: credentials ? {
			email: stringValue(credentials.email),
			password: stringValue(credentials.password),
		} : undefined,
		loginUrl: optionalString(input.loginUrl),
		accountExists: input.accountExists === true,
		registration: registration ? {
			fullName: stringValue(registration.fullName),
			email: stringValue(registration.email),
			password: stringValue(registration.password),
		} : undefined,
	};
}

export async function fillBasicApplicationForm(
	page: Page,
	job: JobApplicationInput,
): Promise<string[]> {
	const filled: string[] = [];
	const candidate = job.candidate;

	// Modern ATS forms (Lever, Greenhouse, Ashby) render their fields client-side
	// after load. Wait for the form to actually appear before scanning, instead
	// of failing in a few hundred ms against an empty DOM.
	await page
		.waitForSelector('input[type="file"], form input, form textarea', {
			state: "attached",
			timeout: 20_000,
		})
		.catch(() => undefined);

	const fillSpecs: Array<[string, string | undefined, string[]]> = [
		["fullName", candidate.fullName, [
			'input[name="fullName"]',
			'input[name="full_name"]',
			'input[name="name"]',
			'input[autocomplete="name"]',
		]],
		["email", candidate.email, [
			'input[name="email"]',
			'input[type="email"]',
			'input[autocomplete="email"]',
		]],
		["phone", candidate.phone, [
			'input[name="phone"]',
			'input[name="mobile"]',
			'input[autocomplete="tel"]',
		]],
		["location", candidate.location, [
			'input[name="location"]',
			'input[autocomplete="address-level2"]',
			'input[autocomplete="address-level1"]',
		]],
		["linkedin", candidate.linkedin, [
			'input[name="linkedin"]',
			'input[name="linkedIn"]',
			'input[placeholder*="LinkedIn" i]',
		]],
		["portfolio", candidate.portfolio, [
			'input[name="portfolio"]',
			'input[name="website"]',
			'input[placeholder*="Portfolio" i]',
			'input[placeholder*="Website" i]',
		]],
		["coverNote", job.coverNote, [
			'textarea[name="coverNote"]',
			'textarea[name="cover_letter"]',
			'textarea[name="coverLetter"]',
			'textarea[placeholder*="cover" i]',
			'textarea[placeholder*="message" i]',
		]],
	];

	for (const [name, value, selectors] of fillSpecs) {
		if (value && await fillFirst(page, selectors, value)) filled.push(name);
	}

	if (candidate.workAuthorization && await selectOrFillFirst(page, [
		'select[name="workAuthorization"]',
		'select[name="work_authorization"]',
		'select[name*="authorization" i]',
	], candidate.workAuthorization)) {
		filled.push("workAuthorization");
	}

	// The résumé input is often hidden (a styled button proxies it), so wait for
	// it to be ATTACHED rather than visible — setInputFiles works on hidden inputs.
	const resumeInput = page.locator(
		'input[type="file"][name*="resume" i], input[type="file"][name*="cv" i], input[type="file"][accept*="pdf" i], input[type="file"]',
	).first();
	try {
		await resumeInput.waitFor({ state: "attached", timeout: 15_000 });
	} catch {
		throw new Error("No resume upload field found on the application form");
	}
	await resumeInput.setInputFiles(job.resumePath);
	filled.push("resume");

	return filled;
}

async function fillFirst(
	page: Page,
	selectors: string[],
	value: string,
): Promise<boolean> {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		if (await locator.count() === 0) continue;
		try {
			await locator.fill(value, { timeout: 5_000 });
			return true;
		} catch {
			/* try next selector */
		}
	}
	return false;
}

async function selectOrFillFirst(
	page: Page,
	selectors: string[],
	value: string,
): Promise<boolean> {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		if (await locator.count() === 0) continue;
		try {
			await locator.selectOption({ label: value }, { timeout: 5_000 });
			return true;
		} catch {
			try {
				await locator.fill(value, { timeout: 5_000 });
				return true;
			} catch {
				/* try next selector */
			}
		}
	}
	return false;
}

export async function submitApplicationForm(page: Page): Promise<void> {
	const form = page.locator("form").first();
	if (await form.count() === 0) throw new Error("No application form found to submit");

	// Never report a false success: if native validation would block the submit
	// (e.g. an unfilled required field, or a required <select> whose options
	// don't match the candidate's value), surface exactly which fields failed
	// instead of clicking into a no-op.
	const invalidFields = await form.evaluate((node) => {
		const f = node as HTMLFormElement;
		if (typeof f.checkValidity !== "function" || f.checkValidity()) return [] as string[];
		return Array.from(f.elements)
			.filter((el): el is HTMLInputElement => {
				const candidate = el as Partial<HTMLInputElement>;
				return typeof candidate.checkValidity === "function" && !candidate.checkValidity();
			})
			.map((el) => el.name || el.getAttribute("aria-label") || el.type || "field")
			.filter(Boolean);
	});
	if (Array.isArray(invalidFields) && invalidFields.length > 0) {
		throw new Error(
			`Application not submitted — these required fields could not be completed: ${invalidFields.join(", ")}`,
		);
	}

	const submit = page.locator(
		'form button[type="submit"], form input[type="submit"], button:has-text("Submit"), button:has-text("Apply"), input[type="submit"]',
	).first();
	if (await submit.count() > 0) {
		// Humanize the approach: arrive at the button along a natural arc before
		// the real click, so behavioral anti-bot scoring sees a hand, not a jump.
		await humanApproach(page, await submit.boundingBox().catch(() => null));
		await submit.click({ timeout: 10_000 });
		return;
	}
	await form.evaluate((node) => {
		const htmlForm = node as HTMLFormElement;
		if (typeof htmlForm.requestSubmit === "function") htmlForm.requestSubmit();
		else htmlForm.submit();
	});
}

// ── Authenticated job application helpers ─────────────────────────────────

export async function detectAuthRequirement(page: Page): Promise<boolean> {
	const body = await page.locator("body").innerHTML({ timeout: 5_000 }).catch(() => "");
	const lower = body.toLowerCase();
	// Check for login/register prompts
	const hasLoginForm = await page.locator(
		'input[type="password"], form[action*="login"], form[action*="signin"]',
	).count() > 0;
	const hasLoginText = /sign\s*in|log\s*in|create\s*(an\s*)?account|register\s*to\s*apply/i.test(lower);
	const hasLoginLink = await page.locator(
		'a[href*="login"], a[href*="signin"], a[href*="register"]',
	).count() > 0;
	return hasLoginForm || (hasLoginText && hasLoginLink);
}

export async function findLoginUrl(page: Page, baseUrl: string): Promise<string | null> {
	const loginLink = page.locator(
		'a[href*="login"], a[href*="signin"], a:has-text("Sign in"), a:has-text("Log in")',
	).first();
	if (await loginLink.count() > 0) {
		const href = await loginLink.getAttribute("href");
		if (href) return new URL(href, baseUrl).toString();
	}
	return null;
}

export async function findRegisterUrl(page: Page, baseUrl: string): Promise<string | null> {
	const regLink = page.locator(
		'a[href*="register"], a[href*="signup"], a:has-text("Create account"), a:has-text("Sign up")',
	).first();
	if (await regLink.count() > 0) {
		const href = await regLink.getAttribute("href");
		if (href) return new URL(href, baseUrl).toString();
	}
	return null;
}

export async function fillLoginForm(
	page: Page,
	credentials: { email: string; password: string },
): Promise<void> {
	await fillFirst(page, [
		'input[name="email"]',
		'input[type="email"]',
		'input[autocomplete="email"]',
		'input[autocomplete="username"]',
		'input[name="username"]',
	], credentials.email);
	await fillFirst(page, [
		'input[name="password"]',
		'input[type="password"]',
		'input[autocomplete="current-password"]',
	], credentials.password);
}

export async function fillRegistrationForm(
	page: Page,
	registration: { fullName: string; email: string; password: string },
): Promise<void> {
	await fillFirst(page, [
		'input[name="fullName"]',
		'input[name="full_name"]',
		'input[name="name"]',
		'input[autocomplete="name"]',
	], registration.fullName);
	await fillFirst(page, [
		'input[name="email"]',
		'input[type="email"]',
		'input[autocomplete="email"]',
	], registration.email);
	await fillFirst(page, [
		'input[name="password"]',
		'input[type="password"]',
		'input[autocomplete="new-password"]',
	], registration.password);
}

export async function submitForm(page: Page): Promise<void> {
	const submit = page.locator(
		'button[type="submit"], input[type="submit"]',
	).first();
	if (await submit.count() > 0) {
		// Humanize the approach: arrive at the button along a natural arc before
		// the real click, so behavioral anti-bot scoring sees a hand, not a jump.
		await humanApproach(page, await submit.boundingBox().catch(() => null));
		await submit.click({ timeout: 10_000 });
		return;
	}
	const form = page.locator("form").first();
	if (await form.count() > 0) {
		await form.evaluate((node) => {
			const f = node as HTMLFormElement;
			if (typeof f.requestSubmit === "function") f.requestSubmit();
			else f.submit();
		});
	}
}
