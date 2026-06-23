import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestJobServerAuth, type TestJobServerAuth } from "./test-job-server-auth.js";

describe("test job server with auth", () => {
	let server: TestJobServerAuth;

	beforeEach(async () => {
		server = await startTestJobServerAuth();
	});

	afterEach(async () => {
		await server.close();
	});

	it("redirects unauthenticated users from /apply to /login", async () => {
		const res = await fetch(`${server.url}/apply`, { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login?next=/apply");
	});

	it("redirects unauthenticated users from /dashboard to /login", async () => {
		const res = await fetch(`${server.url}/dashboard`, { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login?next=/dashboard");
	});

	it("shows the job page without authentication", async () => {
		const res = await fetch(server.jobUrl);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Senior Software Engineer");
		expect(html).toContain("Sign in");
		expect(html).toContain("Create account");
	});

	it("registers a new user and sets session cookie", async () => {
		const res = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test+Candidate&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/dashboard");
		const cookie = res.headers.get("set-cookie") || "";
		expect(cookie).toContain("session=sess_");

		expect(server.users).toHaveLength(1);
		expect(server.users[0].email).toBe("candidate@example.com");
		expect(server.users[0].fullName).toBe("Test Candidate");
	});

	it("rejects registration with duplicate email", async () => {
		await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});

		const res = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test+2&email=candidate@example.com&password=other456",
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("error=Email+already+registered");
		expect(server.users).toHaveLength(1);
	});

	it("rejects registration with short password", async () => {
		const res = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=ab",
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("error=Password+must+be+at+least+6");
	});

	it("logs in an existing user and redirects to next", async () => {
		await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});

		const res = await fetch(`${server.url}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "email=candidate@example.com&password=secret123&next=/apply",
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/apply");
		expect(res.headers.get("set-cookie")).toContain("session=sess_");
	});

	it("rejects login with wrong password", async () => {
		await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});

		const res = await fetch(`${server.url}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "email=candidate@example.com&password=wrong",
			redirect: "manual",
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("error=Invalid+email+or+password");
	});

	it("full flow: register, view apply page, submit application", async () => {
		// Register
		const regRes = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test+Candidate&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});
		const cookie = (regRes.headers.get("set-cookie") || "").split(";")[0];

		// View apply page
		const applyPageRes = await fetch(`${server.url}/apply`, {
			headers: { Cookie: cookie },
		});
		expect(applyPageRes.status).toBe(200);
		const applyHtml = await applyPageRes.text();
		expect(applyHtml).toContain('value="Test Candidate"');
		expect(applyHtml).toContain('value="candidate@example.com"');

		// Submit application
		const form = new FormData();
		form.set("fullName", "Test Candidate");
		form.set("email", "candidate@example.com");
		form.set("phone", "+1 555 0100");
		form.set("location", "Remote");
		form.set("linkedin", "https://linkedin.example/test-candidate");
		form.set("portfolio", "https://portfolio.example");
		form.set("workAuthorization", "Authorized to work in the United States");
		form.set("resume", new File(["Resume body"], "test-resume.txt", { type: "text/plain" }));
		form.set("coverNote", "I am interested in the role.");

		const submitRes = await fetch(`${server.url}/apply`, {
			method: "POST",
			headers: { Cookie: cookie },
			body: form,
			redirect: "manual",
		});

		expect(submitRes.status).toBe(303);
		const location = submitRes.headers.get("location") || "";
		expect(location).toMatch(/^\/success\/fixture_app_/);

		// Verify success page
		const successRes = await fetch(`${server.url}${location}`, {
			headers: { Cookie: cookie },
		});
		expect(successRes.status).toBe(200);
		const successHtml = await successRes.text();
		expect(successHtml).toContain("Application received");
		expect(successHtml).toContain("Test Candidate");

		// Verify submission stored
		expect(server.submissions).toHaveLength(1);
		expect(server.submissions[0].fields).toMatchObject({
			fullName: "Test Candidate",
			email: "candidate@example.com",
		});
		expect(server.submissions[0].userId).toBe(server.users[0].id);
		expect(server.submissions[0].resume).toMatchObject({
			filename: "test-resume.txt",
			size: 11,
		});
	});

	it("dashboard shows user applications", async () => {
		// Register + submit
		const regRes = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});
		const cookie = (regRes.headers.get("set-cookie") || "").split(";")[0];

		const form = new FormData();
		form.set("fullName", "Test");
		form.set("email", "candidate@example.com");
		form.set("resume", new File(["cv"], "cv.txt", { type: "text/plain" }));
		form.set("coverNote", "Hello");
		form.set("workAuthorization", "Authorized to work in the United States");
		await fetch(`${server.url}/apply`, {
			method: "POST",
			headers: { Cookie: cookie },
			body: form,
			redirect: "manual",
		});

		const dashRes = await fetch(`${server.url}/dashboard`, {
			headers: { Cookie: cookie },
		});
		expect(dashRes.status).toBe(200);
		const dashHtml = await dashRes.text();
		expect(dashHtml).toContain("My Applications");
		expect(dashHtml).toContain("Senior Software Engineer");
		expect(dashHtml).toContain("fixture_app_");
	});

	it("logout clears session", async () => {
		const regRes = await fetch(`${server.url}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "fullName=Test&email=candidate@example.com&password=secret123",
			redirect: "manual",
		});
		const cookie = (regRes.headers.get("set-cookie") || "").split(";")[0];

		const logoutRes = await fetch(`${server.url}/logout`, {
			method: "POST",
			headers: { Cookie: cookie },
			redirect: "manual",
		});
		expect(logoutRes.status).toBe(303);
		expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");

		// After logout, /dashboard should redirect to login
		const dashRes = await fetch(`${server.url}/dashboard`, {
			headers: { Cookie: cookie },
			redirect: "manual",
		});
		expect(dashRes.status).toBe(303);
		expect(dashRes.headers.get("location")).toBe("/login?next=/dashboard");
	});
});
