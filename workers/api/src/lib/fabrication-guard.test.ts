import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ancestorGroupNames, fabricationBlockReason, numbersAreSourced, numbersIn, samePhone, type CandidateFacts } from "./fabrication-guard.js";

/**
 * #643 — the two promises that were prompt-only.
 *
 * Half of these tests are the LEGITIMATE cases. A guard that refuses a correctly-formatted real
 * phone number, or an EEO answer the user actually gave, does not make an application safer — it
 * breaks a working one, and the pause it causes costs a human. So each refusal below is paired
 * with the case it must NOT refuse.
 */

const JOB: CandidateFacts = {
	candidate: {
		fullName: "Sergey Ivochkin",
		email: "sergey@example.com",
		phone: "+61 412 345 678",
		location: "Sydney, NSW, Australia",
		salaryExpectation: "120000 AUD",
	},
};

const type = (name: string, text: string, ref?: string) => ({ action: "type", role: "textbox", name, text, ref });
const select = (name: string, text: string, ref?: string) => ({ action: "select", role: "combobox", name, text, ref });
const check = (name: string, ref?: string) => ({ action: "check", role: "checkbox", name, ref });

describe("EEO / self-identification answers", () => {
	it("refuses a gender the candidate never stated, and names the decline option instead", () => {
		const reason = fabricationBlockReason(select("Gender", "Male"), JOB);
		expect(reason).toMatch(/REFUSED/);
		expect(reason).toMatch(/Decline to self-identify/);
	});

	it("allows the decline option — the answer the prompt asks for", () => {
		expect(fabricationBlockReason(select("Gender", "Decline to self-identify"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Race / Ethnicity", "I don't wish to answer"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Veteran status", "I choose not to disclose"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Disability status", "Prefer not to say"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Demographic questions", "Undisclosed"), JOB)).toBeNull();
	});

	it("refuses a veteran/disability claim made through a checkbox, where the option label IS the claim", () => {
		expect(fabricationBlockReason(check("I identify as a protected veteran"), JOB)).toMatch(/REFUSED/);
		expect(fabricationBlockReason(check("Yes, I have a disability"), JOB)).toMatch(/REFUSED/);
		// A negative claim is a claim: "I am not a protected veteran" is a statement about the
		// candidate that nobody gave the agent. The prompt's rule is decline, not guess either way.
		expect(fabricationBlockReason(check("I am NOT a protected veteran"), JOB)).toMatch(/REFUSED/);
	});

	it("allows a decline checkbox", () => {
		expect(fabricationBlockReason(check("I don't wish to answer — veteran status"), JOB)).toBeNull();
		expect(fabricationBlockReason(check("I decline to self-identify"), JOB)).toBeNull();
	});

	it("ALLOWS an answer the user actually supplied — the prompt's own exemption", () => {
		const provided: CandidateFacts = { ...JOB, providedAnswers: { gender: "Male" } };
		expect(fabricationBlockReason(select("Gender", "Male"), provided)).toBeNull();
	});

	it("does not read the OPPOSITE answer out of the one the user gave", () => {
		// The trap a plain `includes` walks into: "Female" contains "male". Word-bounded matching
		// is the difference between honouring the user's answer and inverting it on a real form.
		const provided: CandidateFacts = { ...JOB, providedAnswers: { gender: "Female" } };
		expect(fabricationBlockReason(select("Gender", "Male"), provided)).toMatch(/REFUSED/);
		expect(fabricationBlockReason(select("Gender", "Female"), provided)).toBeNull();
	});

	it("ignores an unanswered dropdown — a placeholder states nothing", () => {
		expect(fabricationBlockReason(select("Gender", "Select..."), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Gender", "Select one"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("Gender", ""), JOB)).toBeNull();
	});

	it("reads the control's name off the PAGE, not only the model's claim (#627's lesson)", () => {
		const snapshot = ['- textbox "Full name" [ref=e3]', '- combobox "Gender" [ref=e5]'].join("\n");
		// The model labelled it something bland; the page says Gender.
		expect(fabricationBlockReason(select("Question 4", "Male", "e5"), JOB, snapshot)).toMatch(/REFUSED/);
	});

	it("leaves a non-demographic dropdown alone", () => {
		expect(fabricationBlockReason(select("Notice period", "4 weeks"), JOB)).toBeNull();
		expect(fabricationBlockReason(select("How did you hear about us?", "LinkedIn"), JOB)).toBeNull();
		expect(fabricationBlockReason(check("I agree to the privacy policy"), JOB)).toBeNull();
	});
});

/**
 * The RADIO case, which is how Greenhouse and Workday actually render EEO. The action says only
 * "Male" — the question lives one level up in the ARIA tree, so without walking to the containing
 * group the highest-harm case in the ticket is out of reach on the two ATS that matter most.
 */
describe("EEO asked as radio buttons under a group", () => {
	const EEO_FORM = [
		'- main [ref=e1]:',
		'  - group "Voluntary Self-Identification" [ref=e10]:',
		'    - group "Gender" [ref=e11]:',
		'      - radio "Male" [ref=e12]',
		'      - radio "Female" [ref=e13]',
		'      - radio "Decline to self-identify" [ref=e14]',
		'  - group "Contact details" [ref=e20]:',
		'    - checkbox "Email me about similar roles" [ref=e21]',
		'    - radio "Yes" [ref=e22]',
	].join("\n");

	it("refuses a gender radio whose own label says nothing demographic", () => {
		const reason = fabricationBlockReason(check("Male", "e12"), JOB, EEO_FORM);
		expect(reason).toMatch(/REFUSED/);
		// The refusal quotes the OPTION, not the group — that is the value it stopped.
		expect(reason).toMatch(/"Male" would state a protected characteristic/);
	});

	it("allows the decline radio in the same group", () => {
		expect(fabricationBlockReason(check("Decline to self-identify", "e14"), JOB, EEO_FORM)).toBeNull();
	});

	it("does NOT drag an unrelated control into the EEO test just because it is nested", () => {
		// `group "Contact details"` is not demographic, and the walk stops at the ancestors — a
		// sibling group's name must never reach this control.
		expect(fabricationBlockReason(check("Yes", "e22"), JOB, EEO_FORM)).toBeNull();
		expect(fabricationBlockReason(check("Email me about similar roles", "e21"), JOB, EEO_FORM)).toBeNull();
	});

	it("ancestorGroupNames walks up, skips siblings, and stops at group-ish roles", () => {
		expect(ancestorGroupNames(EEO_FORM, "e12")).toEqual(["Gender", "Voluntary Self-Identification"]);
		// `main` is not group-ish: a page-level container's name must not classify every control.
		expect(ancestorGroupNames(EEO_FORM, "e22")).toEqual(["Contact details"]);
		expect(ancestorGroupNames(EEO_FORM, "e99")).toEqual([]);
		expect(ancestorGroupNames("", "e12")).toEqual([]);
	});

	it("the group name is NOT used to classify a typed field", () => {
		// A `group "Salary history"` around a `textbox "Year"` would otherwise turn a date into a
		// salary and refuse it. Only the control's OWN name classifies a `type`.
		const form = ['- group "Salary history" [ref=e30]:', '  - textbox "Year" [ref=e31]'].join("\n");
		expect(fabricationBlockReason(type("Year", "2019", "e31"), JOB, form)).toBeNull();
	});
});

describe("typed identity values", () => {
	it("allows the candidate's real phone number in ANY format", () => {
		// The stored value is "+61 412 345 678". All of these are the same number, and refusing
		// one of them would break an application that was doing exactly the right thing.
		for (const t of ["+61 412 345 678", "0412 345 678", "0412345678", "(04) 1234 5678", "412345678", "+61412345678"]) {
			expect(fabricationBlockReason(type("Phone", t), JOB), t).toBeNull();
		}
	});

	it("refuses a phone number that appears nowhere in the candidate's data, and points at request_user_info", () => {
		const reason = fabricationBlockReason(type("Mobile number *", "0400 000 000"), JOB);
		expect(reason).toMatch(/REFUSED/);
		expect(reason).toMatch(/request_user_info/);
		expect(reason).toMatch(/do not try a different format/);
	});

	it("allows a phone the user supplied mid-run via ask-and-hold", () => {
		const provided: CandidateFacts = { candidate: { fullName: "S I", email: "s@example.com" }, providedAnswers: { "phone number": "0499 111 222" } };
		expect(fabricationBlockReason(type("Phone", "0499111222"), provided)).toBeNull();
		expect(fabricationBlockReason(type("Phone", "0499 111 999"), provided)).toMatch(/REFUSED/);
	});

	it("allows a value the user handed the agent in their OWN words", () => {
		// Special Instructions and a live mid-run message are the user typing a value at the agent.
		// A guard that ignored them would refuse the one thing the user explicitly asked for.
		const ruled: CandidateFacts = { candidate: { fullName: "S I", email: "s@example.com" }, specialInstructions: "Use my work mobile 0455 987 654 on applications, not my personal one." };
		expect(fabricationBlockReason(type("Mobile", "0455987654"), ruled)).toBeNull();
		const hinted: CandidateFacts = { ...JOB, userHint: "my salary expectation for this one is 145000" };
		expect(fabricationBlockReason(type("Expected salary", "145000"), hinted)).toBeNull();
	});

	it("does NOT treat a previous run's ATS route as candidate data (#633)", () => {
		// `cacheHint` deliberately withholds a prior run's typed values because one ATS host serves
		// many employers. If it counted as "sourced", this guard would re-open that leak.
		const cached = { ...JOB, cacheHint: "typed 0400 000 000 into Phone — worked" } as CandidateFacts;
		expect(fabricationBlockReason(type("Phone", "0400 000 000"), cached)).toMatch(/REFUSED/);
	});

	it("ignores a phone FRAGMENT — a country or area code is not an invented number", () => {
		expect(fabricationBlockReason(type("Phone country code", "+61"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Phone extension", "123"), JOB)).toBeNull();
		// "Mobile" also names a skills question. Two digits are not a fabricated phone number.
		expect(fabricationBlockReason(type("Years of mobile development", "8"), JOB)).toBeNull();
	});

	it("allows the candidate's email and refuses another one", () => {
		expect(fabricationBlockReason(type("Email address", "sergey@example.com"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Confirm email", "SERGEY@EXAMPLE.COM"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Email address", "s.ivochkin@gmail.com"), JOB)).toMatch(/REFUSED/);
	});

	it("does not read a shorter fabricated address out of the real one", () => {
		// A bare `includes` finds "y@example.com" inside "sergey@example.com" and waves through an
		// address the candidate does not own. The same word-boundary rule that stops Male/Female.
		expect(fabricationBlockReason(type("Email address", "y@example.com"), JOB)).toMatch(/REFUSED/);
	});

	it("does not judge a non-email typed into an email-ish box", () => {
		expect(fabricationBlockReason(type("Email preferences", "N/A"), JOB)).toBeNull();
	});

	it("allows the stored salary however it is written, and refuses a different figure", () => {
		// Every one of these is 120000 — the figure the candidate gave. The FIGURE is what is
		// compared; the currency, separators and prose around it are noise. An earlier version
		// compared the whole normalised string, which made "AUD 120,000 per annum" a refusal.
		for (const t of ["120000", "$120,000", "120,000 AUD", "AUD 120,000 per annum", "120k", "120 000"]) {
			expect(fabricationBlockReason(type("Expected salary", t), JOB), t).toBeNull();
		}
		expect(fabricationBlockReason(type("Expected salary", "150000"), JOB)).toMatch(/REFUSED/);
	});

	it("refuses a RANGE the candidate never stated, even when one end is theirs", () => {
		// "$110,000 – $130,000" against a stored 120000 is two invented numbers. Accepting it
		// because a nearby figure matched would put a band the candidate never gave on a real form.
		expect(fabricationBlockReason(type("Salary expectation", "$110,000 - $130,000"), JOB)).toMatch(/REFUSED/);
		expect(fabricationBlockReason(type("Salary expectation", "120000 - 140000"), JOB)).toMatch(/REFUSED/);
	});

	it("does not treat a number found INSIDE another number as sourced", () => {
		// "2000" is a substring of the stored "120000". Comparing whole figures rather than digit
		// runs is what stops the guard waving through a number the candidate never gave.
		expect(fabricationBlockReason(type("Expected salary", "2000"), JOB)).toMatch(/REFUSED/);
	});

	it("allows prose in a salary box — an opinion is not an invented figure", () => {
		expect(fabricationBlockReason(type("Salary expectation", "Negotiable"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Expected compensation", "Open to discussion"), JOB)).toBeNull();
	});

	it("leaves every other field alone — a free-text screening answer is not decidable here", () => {
		expect(fabricationBlockReason(type("Years of Python experience", "8"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Why do you want this role?", "I have shipped…"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("LinkedIn profile", "https://linkedin.com/in/someone"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("Full name", "Sergey Ivochkin"), JOB)).toBeNull();
	});

	it("does NOT guard the postcode, on purpose — the answer would never come back", () => {
		// `user_profile` has a `postalCode` column and `profileToCandidate` builds `location` from
		// city/state/country only, so the postcode never reaches the prompt. Guarding it would pause
		// every application with an address block — and pause it AGAIN next run, because
		// `guessProfileKey` files the answer under the standard key `postalCode`, which
		// `profileCustomAnswers` skips and `profileToCandidate` drops. The round trip is the
		// criterion; fixing it is a change to the profile→candidate mapping, not to this guard.
		expect(fabricationBlockReason(type("Postcode", "2000"), JOB)).toBeNull();
		expect(fabricationBlockReason(type("ZIP code", "94107"), JOB)).toBeNull();
	});

	it("never touches an action that carries no value", () => {
		expect(fabricationBlockReason({ action: "click", name: "Submit application" }, JOB)).toBeNull();
		expect(fabricationBlockReason({ action: "upload", name: "Resume" }, JOB)).toBeNull();
		expect(fabricationBlockReason(null, JOB)).toBeNull();
		expect(fabricationBlockReason(type("Phone", ""), JOB)).toBeNull();
	});

	it("never guards a SELECT on a number — a salary band is a choice the page offered", () => {
		expect(fabricationBlockReason(select("Expected salary range", "$120k - $140k"), JOB)).toBeNull();
	});
});

describe("the normalisation rules, directly", () => {
	it("samePhone: one number, six spellings; two numbers, never", () => {
		expect(samePhone("+61 412 345 678", "0412345678")).toBe(true);
		expect(samePhone("(04) 1234 5678", "0412345678")).toBe(true);
		expect(samePhone("0412345678 x123", "0412345678")).toBe(true);
		expect(samePhone("+1 415 555 0123", "4155550123")).toBe(true);
		expect(samePhone("0412345678", "0498765432")).toBe(false);
		// Too short to compare by suffix, and not contained: two different fragments.
		expect(samePhone("12345", "67890")).toBe(false);
	});

	it("numbersIn: separators are noise, a k/m suffix is a multiplier", () => {
		expect(numbersIn("$120,000")).toEqual(["120000"]);
		expect(numbersIn("120 000")).toEqual(["120000"]);
		expect(numbersIn("AUD 120,000 per annum")).toEqual(["120000"]);
		expect(numbersIn("120k")).toEqual(["120000"]);
		expect(numbersIn("1.2m")).toEqual(["1200000"]);
		expect(numbersIn("$110,000 - $130,000")).toEqual(["110000", "130000"]);
		expect(numbersIn("Negotiable")).toEqual([]);
	});

	it("numbersAreSourced: every figure must be one the user gave", () => {
		expect(numbersAreSourced("$120,000", ["120000 AUD"])).toBe(true);
		expect(numbersAreSourced("120k", ["$120,000 per annum"])).toBe(true);
		expect(numbersAreSourced("2000", ["120000"])).toBe(false);
		expect(numbersAreSourced("120000 - 140000", ["120000"])).toBe(false);
		expect(numbersAreSourced("", ["120000"])).toBe(false);
	});
});

describe("the guard is wired into the act path", () => {
	/**
	 * The invariant, not the implementation: a pure guard nobody calls is a comment. This is the
	 * same shape as the dry-run block it sits beside — that one was added because the prompt was
	 * not enough, and it only works because `job-apply.ts` consults it before `/browser/act`.
	 */
	const SRC = new URL("../", import.meta.url).pathname; // workers/api/src
	const src = readFileSync(join(SRC, "workflows/job-apply.ts"), "utf8");

	it("job-apply.ts consults it before forwarding an action to the runner", () => {
		expect(src).toMatch(/fabricationBlockReason\(/);
		// Before the act call, not after it.
		expect(src.indexOf("fabricationBlockReason(")).toBeLessThan(src.indexOf('callRunner<{ url: string; challenge: string | null; feedback?: string'));
		// And recorded where the owner can find it.
		expect(src).toMatch(/apply\.unsourced_value/);
	});

	it("is NOT gated on dryRun — a real application is exactly when fabrication matters", () => {
		// The neutering this test exists to catch: `job.dryRun ? fabricationBlockReason(…) : null`,
		// copied from the line above it, which would leave every REAL application unguarded while
		// every test above still passed.
		const call = src.split("\n").find((l) => l.includes("fabricationBlockReason(")) ?? "";
		expect(call).not.toBe("");
		expect(call).not.toMatch(/dryRun/);
	});

	it("REFUSES rather than silently correcting the value", () => {
		// The other obvious wrong fix: rewrite `a.text` to the candidate's real value and act
		// anyway. That is a second invisible behaviour on the path this exists to make visible —
		// the owner would still have no signal the model tried to invent something.
		expect(src).not.toMatch(/\ba\.text\s*=[^=]/);
	});
});
