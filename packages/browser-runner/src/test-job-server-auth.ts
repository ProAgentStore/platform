import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface TestJobSubmission {
	id: string;
	userId: string;
	fields: Record<string, string>;
	resume?: {
		filename: string;
		contentType: string;
		size: number;
	};
	createdAt: string;
}

export interface TestUser {
	id: string;
	email: string;
	password: string;
	fullName: string;
	createdAt: string;
}

export interface TestJobServerAuth {
	url: string;
	jobUrl: string;
	loginUrl: string;
	registerUrl: string;
	submissions: TestJobSubmission[];
	users: TestUser[];
	sessions: Map<string, string>;
	close: () => Promise<void>;
}

export async function startTestJobServerAuth(port = 0): Promise<TestJobServerAuth> {
	const submissions: TestJobSubmission[] = [];
	const users: TestUser[] = [];
	const sessions = new Map<string, string>();

	const server = createServer(async (req, res) => {
		try {
			await route(req, res, { submissions, users, sessions });
		} catch (error) {
			html(res, 500, page("Error", `<main><h1>Server Error</h1><pre>${escapeHtml(String(error))}</pre></main>`));
		}
	});
	await new Promise<void>((resolve) => {
		server.listen(port, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${address.port}`;
	return {
		url,
		jobUrl: `${url}/jobs/software-engineer`,
		loginUrl: `${url}/login`,
		registerUrl: `${url}/register`,
		submissions,
		users,
		sessions,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

interface ServerState {
	submissions: TestJobSubmission[];
	users: TestUser[];
	sessions: Map<string, string>;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	state: ServerState,
): Promise<void> {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const sessionId = parseCookie(req.headers.cookie || "", "session");
	const userId = sessionId ? state.sessions.get(sessionId) : undefined;
	const user = userId ? state.users.find((u) => u.id === userId) : undefined;

	if (req.method === "GET" && url.pathname === "/") {
		redirect(res, "/jobs/software-engineer");
		return;
	}

	if (req.method === "GET" && url.pathname === "/register") {
		const error = url.searchParams.get("error") || "";
		html(res, 200, registerPage(error));
		return;
	}

	if (req.method === "POST" && url.pathname === "/register") {
		const body = await parseFormBody(req);
		const email = body.email?.trim().toLowerCase();
		const password = body.password?.trim();
		const fullName = body.fullName?.trim();

		if (!email || !password || !fullName) {
			redirect(res, "/register?error=All+fields+are+required");
			return;
		}
		if (password.length < 6) {
			redirect(res, "/register?error=Password+must+be+at+least+6+characters");
			return;
		}
		if (state.users.some((u) => u.email === email)) {
			redirect(res, "/register?error=Email+already+registered");
			return;
		}

		const newUser: TestUser = {
			id: `user_${crypto.randomUUID()}`,
			email,
			password,
			fullName,
			createdAt: new Date().toISOString(),
		};
		state.users.push(newUser);

		const newSessionId = `sess_${crypto.randomUUID()}`;
		state.sessions.set(newSessionId, newUser.id);
		setSessionCookie(res, newSessionId);
		redirect(res, "/dashboard");
		return;
	}

	if (req.method === "GET" && url.pathname === "/login") {
		if (user) {
			redirect(res, "/dashboard");
			return;
		}
		const error = url.searchParams.get("error") || "";
		const next = url.searchParams.get("next") || "";
		html(res, 200, loginPage(error, next));
		return;
	}

	if (req.method === "POST" && url.pathname === "/login") {
		const body = await parseFormBody(req);
		const email = body.email?.trim().toLowerCase();
		const password = body.password?.trim();
		const next = body.next?.trim() || "/dashboard";

		if (!email || !password) {
			redirect(res, `/login?error=Email+and+password+required&next=${encodeURIComponent(next)}`);
			return;
		}

		const found = state.users.find((u) => u.email === email && u.password === password);
		if (!found) {
			redirect(res, `/login?error=Invalid+email+or+password&next=${encodeURIComponent(next)}`);
			return;
		}

		const newSessionId = `sess_${crypto.randomUUID()}`;
		state.sessions.set(newSessionId, found.id);
		setSessionCookie(res, newSessionId);
		redirect(res, next);
		return;
	}

	if (req.method === "POST" && url.pathname === "/logout") {
		if (sessionId) state.sessions.delete(sessionId);
		clearSessionCookie(res);
		redirect(res, "/login");
		return;
	}

	if (req.method === "GET" && url.pathname === "/jobs/software-engineer") {
		html(res, 200, jobPage(user));
		return;
	}

	if (req.method === "GET" && url.pathname === "/apply") {
		if (!user) {
			redirect(res, "/login?next=/apply");
			return;
		}
		html(res, 200, applyPage(user));
		return;
	}

	if (req.method === "POST" && url.pathname === "/apply") {
		if (!user) {
			redirect(res, "/login?next=/apply");
			return;
		}
		const submission = await parseApplication(req, user.id);
		state.submissions.unshift(submission);
		redirect(res, `/success/${submission.id}`);
		return;
	}

	if (req.method === "GET" && url.pathname === "/dashboard") {
		if (!user) {
			redirect(res, "/login?next=/dashboard");
			return;
		}
		const userSubmissions = state.submissions.filter((s) => s.userId === user.id);
		html(res, 200, dashboardPage(user, userSubmissions));
		return;
	}

	if (req.method === "GET" && url.pathname.startsWith("/success/")) {
		if (!user) {
			redirect(res, "/login");
			return;
		}
		const id = url.pathname.split("/").pop() || "";
		const submission = state.submissions.find((row) => row.id === id && row.userId === user.id);
		if (!submission) {
			html(res, 404, page("Not Found", "<main><h1>Application not found</h1></main>"));
			return;
		}
		html(res, 200, successPage(submission));
		return;
	}

	if (req.method === "GET" && url.pathname === "/submissions") {
		json(res, 200, { submissions: state.submissions });
		return;
	}

	html(res, 404, page("Not Found", "<main><h1>Not found</h1></main>"));
}

function registerPage(error: string): string {
	return page("Create Account", `
    <main>
      <section class="auth-card">
        <h1>Create Account</h1>
        <p class="subtitle">Join Fixture Labs to apply for positions</p>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        <form action="/register" method="post" class="auth-form">
          <label>Full name <input name="fullName" autocomplete="name" required /></label>
          <label>Email <input name="email" type="email" autocomplete="email" required /></label>
          <label>Password <input name="password" type="password" autocomplete="new-password" minlength="6" required /></label>
          <button type="submit">Create account</button>
        </form>
        <p class="switch">Already have an account? <a href="/login">Sign in</a></p>
      </section>
    </main>
  `);
}

function loginPage(error: string, next: string): string {
	return page("Sign In", `
    <main>
      <section class="auth-card">
        <h1>Sign In</h1>
        <p class="subtitle">Sign in to continue your application</p>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        <form action="/login" method="post" class="auth-form">
          <input type="hidden" name="next" value="${escapeHtml(next || "/dashboard")}" />
          <label>Email <input name="email" type="email" autocomplete="email" required /></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
          <button type="submit">Sign in</button>
        </form>
        <p class="switch">Don't have an account? <a href="/register">Create one</a></p>
      </section>
    </main>
  `);
}

function jobPage(user: TestUser | undefined): string {
	const nav = user
		? `<nav><span>Signed in as ${escapeHtml(user.fullName)}</span> <a href="/dashboard">Dashboard</a></nav>`
		: `<nav><a href="/login">Sign in</a> <a href="/register">Create account</a></nav>`;
	return page("Senior Software Engineer", `
    ${nav}
    <main>
      <section class="job">
        <p class="eyebrow">PAGS Test Fixture</p>
        <h1>Senior Software Engineer</h1>
        <p class="company">Fixture Labs</p>
        <p>Build workflow tools for safe browser agents. This role values TypeScript, automation, product judgment, and careful user approval flows.</p>
        <h2>Requirements</h2>
        <ul>
          <li>5+ years TypeScript/JavaScript experience</li>
          <li>Experience with browser automation (Playwright, Puppeteer)</li>
          <li>Strong product sense and attention to UX details</li>
          <li>Comfortable with distributed systems and Workers</li>
        </ul>
        <h2>Benefits</h2>
        <ul>
          <li>Fully remote</li>
          <li>Competitive compensation</li>
          <li>Health, dental, vision</li>
        </ul>
        <a href="/apply" class="apply-button">Apply for this position</a>
      </section>
    </main>
  `);
}

function applyPage(user: TestUser): string {
	return page("Apply - Senior Software Engineer", `
    <nav><span>Signed in as ${escapeHtml(user.fullName)}</span> <a href="/dashboard">Dashboard</a></nav>
    <main>
      <section class="job-header">
        <p class="eyebrow">Applying for</p>
        <h1>Senior Software Engineer</h1>
        <p class="company">Fixture Labs</p>
      </section>
      <form action="/apply" method="post" enctype="multipart/form-data" class="application-form">
        <label>Full name <input name="fullName" autocomplete="name" value="${escapeHtml(user.fullName)}" required /></label>
        <label>Email <input name="email" type="email" autocomplete="email" value="${escapeHtml(user.email)}" required /></label>
        <label>Phone <input name="phone" autocomplete="tel" /></label>
        <label>Location <input name="location" autocomplete="address-level2" /></label>
        <label>LinkedIn <input name="linkedin" type="url" /></label>
        <label>Portfolio <input name="portfolio" type="url" /></label>
        <label>Work authorization
          <select name="workAuthorization" required>
            <option value="">Select one</option>
            <option>Authorized to work in the United States</option>
            <option>Require sponsorship</option>
          </select>
        </label>
        <label>Resume <input name="resume" type="file" accept=".pdf,.txt,.doc,.docx" required /></label>
        <label>Cover note <textarea name="coverNote" rows="5" required></textarea></label>
        <button type="submit">Submit application</button>
      </form>
    </main>
  `);
}

function dashboardPage(user: TestUser, submissions: TestJobSubmission[]): string {
	const rows = submissions.length
		? submissions.map((s) => `
        <tr>
          <td>${escapeHtml(s.id)}</td>
          <td>Senior Software Engineer</td>
          <td>${escapeHtml(s.createdAt.split("T")[0])}</td>
          <td><a href="/success/${escapeHtml(s.id)}">View</a></td>
        </tr>
      `).join("")
		: `<tr><td colspan="4" class="empty">No applications yet. <a href="/jobs/software-engineer">Browse jobs</a></td></tr>`;

	return page("Dashboard", `
    <nav><span>Signed in as ${escapeHtml(user.fullName)}</span>
      <form action="/logout" method="post" style="display:inline"><button type="submit" class="link-button">Sign out</button></form>
    </nav>
    <main>
      <section class="dashboard">
        <h1>My Applications</h1>
        <table>
          <thead><tr><th>ID</th><th>Position</th><th>Date</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    </main>
  `);
}

function successPage(submission: TestJobSubmission): string {
	return page("Application Received", `
    <main>
      <section class="success">
        <p class="eyebrow">Success</p>
        <h1>Application received</h1>
        <p id="application-id">${escapeHtml(submission.id)}</p>
        <p>Thank you, ${escapeHtml(submission.fields.fullName || "candidate")}.</p>
        <p>Resume: ${escapeHtml(submission.resume?.filename || "missing")} (${submission.resume?.size || 0} bytes)</p>
        <a href="/dashboard">Back to dashboard</a>
      </section>
    </main>
  `);
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f6f8fb; color: #16202a; }
    main { width: min(880px, calc(100% - 32px)); margin: 40px auto; }
    nav { display: flex; align-items: center; gap: 16px; padding: 12px 24px; background: white; border-bottom: 1px solid #d7dee8; }
    nav span { font-weight: 600; margin-right: auto; }
    nav a, .switch a { color: #4f46e5; text-decoration: none; font-weight: 600; }
    .job, .success, .auth-card, .dashboard, .job-header, form.application-form { background: white; border: 1px solid #d7dee8; border-radius: 8px; padding: 24px; margin-bottom: 16px; }
    .auth-card { max-width: 400px; margin: 60px auto; }
    .auth-form, .application-form { display: grid; gap: 16px; margin-top: 16px; }
    label { display: grid; gap: 6px; font-weight: 650; }
    input, select, textarea { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #aab6c4; border-radius: 6px; font: inherit; }
    button[type="submit"] { width: fit-content; padding: 10px 16px; border: 0; border-radius: 6px; background: #166534; color: white; font-weight: 700; cursor: pointer; }
    .link-button { background: none; border: none; color: #4f46e5; font-weight: 600; cursor: pointer; font: inherit; padding: 0; }
    .apply-button { display: inline-block; margin-top: 20px; padding: 12px 20px; background: #166534; color: white; border-radius: 6px; text-decoration: none; font-weight: 700; }
    .eyebrow { color: #4f46e5; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .company { font-weight: 700; }
    .subtitle { color: #566778; }
    .switch { text-align: center; color: #566778; margin-top: 16px; }
    .error { color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e9f0; }
    th { font-weight: 700; color: #566778; text-transform: uppercase; font-size: 0.8em; letter-spacing: .04em; }
    .empty { text-align: center; color: #566778; padding: 32px; }
    ul { padding-left: 20px; line-height: 1.8; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function parseApplication(req: IncomingMessage, userId: string): Promise<TestJobSubmission> {
	const contentType = req.headers["content-type"] || "";
	if (!contentType.includes("multipart/form-data")) {
		throw new Error("Expected multipart/form-data");
	}
	const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
	if (!boundary) throw new Error("Missing multipart boundary");
	const raw = await readBody(req);
	const parsed = parseMultipart(raw, boundary);
	return {
		id: `fixture_app_${crypto.randomUUID()}`,
		userId,
		fields: parsed.fields,
		resume: parsed.files.resume,
		createdAt: new Date().toISOString(),
	};
}

function parseMultipart(
	raw: Buffer,
	boundary: string,
): {
	fields: Record<string, string>;
	files: Record<string, { filename: string; contentType: string; size: number }>;
} {
	const fields: Record<string, string> = {};
	const files: Record<string, { filename: string; contentType: string; size: number }> = {};
	const delimiter = Buffer.from(`--${boundary}`);
	let offset = 0;
	while (offset < raw.length) {
		const start = raw.indexOf(delimiter, offset);
		if (start === -1) break;
		const partStart = start + delimiter.length;
		if (raw.subarray(partStart, partStart + 2).toString() === "--") break;
		const headerStart = raw.subarray(partStart, partStart + 2).toString() === "\r\n"
			? partStart + 2
			: partStart;
		const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"), headerStart);
		if (headerEnd === -1) break;
		const next = raw.indexOf(delimiter, headerEnd + 4);
		if (next === -1) break;
		const headers = raw.subarray(headerStart, headerEnd).toString("utf-8");
		const body = trimPartBody(raw.subarray(headerEnd + 4, next));
		const name = headers.match(/name="([^"]+)"/)?.[1];
		const filename = headers.match(/filename="([^"]*)"/)?.[1];
		const ct = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
		if (name && filename) {
			files[name] = { filename, contentType: ct, size: body.length };
		} else if (name) {
			fields[name] = body.toString("utf-8");
		}
		offset = next;
	}
	return { fields, files };
}

function trimPartBody(value: Buffer): Buffer {
	if (value.subarray(-2).toString() === "\r\n") return value.subarray(0, -2);
	return value;
}

async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
	const raw = await readBody(req);
	const params = new URLSearchParams(raw.toString("utf-8"));
	const result: Record<string, string> = {};
	for (const [key, value] of params.entries()) result[key] = value;
	return result;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function parseCookie(header: string, name: string): string | undefined {
	const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match ? match[1] : undefined;
}

function setSessionCookie(res: ServerResponse, sessionId: string): void {
	res.setHeader("Set-Cookie", `session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res: ServerResponse): void {
	res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function redirect(res: ServerResponse, location: string): void {
	res.writeHead(303, { Location: location });
	res.end();
}

function html(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case '"': return "&quot;";
			default: return "&#39;";
		}
	});
}
