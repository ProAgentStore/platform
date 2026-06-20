import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

describe("test job application server", () => {
	let server: TestJobServer;

	beforeEach(async () => {
		server = await startTestJobServer();
	});

	afterEach(async () => {
		await server.close();
	});

	it("serves a job application page with standard details and resume upload", async () => {
		const res = await fetch(server.jobUrl);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain("Senior Software Engineer");
		expect(html).toContain('name="fullName"');
		expect(html).toContain('name="email"');
		expect(html).toContain('name="resume" type="file"');
		expect(html).toContain('enctype="multipart/form-data"');
	});

	it("accepts a resume upload and redirects to a success page", async () => {
		const form = new FormData();
		form.set("fullName", "Sam Candidate");
		form.set("email", "sam@example.com");
		form.set("phone", "+1 555 0100");
		form.set("location", "Remote");
		form.set("linkedin", "https://linkedin.com/in/sam");
		form.set("portfolio", "https://sam.dev");
		form.set("workAuthorization", "Authorized to work in the United States");
		form.set(
			"resume",
			new File(["Resume body"], "sam-resume.txt", { type: "text/plain" }),
		);
		form.set("coverNote", "I am interested in the role.");

		const submit = await fetch(`${server.url}/apply`, {
			method: "POST",
			body: form,
			redirect: "manual",
		});

		expect(submit.status).toBe(303);
		const location = submit.headers.get("location");
		expect(location).toMatch(/^\/success\/fixture_app_/);

		const success = await fetch(`${server.url}${location}`);
		const successHtml = await success.text();
		expect(success.status).toBe(200);
		expect(successHtml).toContain("Application received");
		expect(successHtml).toContain("Sam Candidate");
		expect(successHtml).toContain("sam-resume.txt");

		expect(server.submissions).toHaveLength(1);
		expect(server.submissions[0].fields).toMatchObject({
			fullName: "Sam Candidate",
			email: "sam@example.com",
			coverNote: "I am interested in the role.",
		});
		expect(server.submissions[0].resume).toMatchObject({
			filename: "sam-resume.txt",
			contentType: "text/plain",
			size: 11,
		});
	});
});
