import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface TestJobSubmission {
	id: string;
	fields: Record<string, string>;
	resume?: {
		filename: string;
		contentType: string;
		size: number;
	};
	createdAt: string;
}

export interface TestJobServer {
	url: string;
	jobUrl: string;
	submissions: TestJobSubmission[];
	close: () => Promise<void>;
}

export async function startTestJobServer(port = 0): Promise<TestJobServer> {
	const submissions: TestJobSubmission[] = [];
	const server = createServer(async (req, res) => {
		try {
			await route(req, res, submissions);
		} catch (error) {
			html(res, 500, `<h1>Server Error</h1><pre>${escapeHtml(String(error))}</pre>`);
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
		submissions,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	submissions: TestJobSubmission[],
): Promise<void> {
	const url = new URL(req.url || "/", "http://127.0.0.1");
	if (req.method === "GET" && url.pathname === "/") {
		redirect(res, "/jobs/software-engineer");
		return;
	}
	if (req.method === "GET" && url.pathname === "/jobs/software-engineer") {
		html(res, 200, jobPage());
		return;
	}
	if (req.method === "POST" && url.pathname === "/apply") {
		const submission = await parseApplication(req);
		submissions.unshift(submission);
		redirect(res, `/success/${submission.id}`);
		return;
	}
	if (req.method === "GET" && url.pathname.startsWith("/success/")) {
		const id = url.pathname.split("/").pop() || "";
		const submission = submissions.find((row) => row.id === id);
		if (!submission) {
			html(res, 404, "<h1>Application not found</h1>");
			return;
		}
		html(res, 200, successPage(submission));
		return;
	}
	if (req.method === "GET" && url.pathname === "/submissions") {
		json(res, 200, { submissions });
		return;
	}
	html(res, 404, "<h1>Not found</h1>");
}

function jobPage(): string {
	return page("Senior Software Engineer", `
    <main>
      <section class="job">
        <p class="eyebrow">PAGS Test Fixture</p>
        <h1>Senior Software Engineer</h1>
        <p class="company">Fixture Labs</p>
        <p>Build workflow tools for safe browser agents. This role values TypeScript, automation, product judgment, and careful user approval flows.</p>
      </section>
      <form action="/apply" method="post" enctype="multipart/form-data" class="application-form">
        <label>Full name <input name="fullName" autocomplete="name" required /></label>
        <label>Email <input name="email" type="email" autocomplete="email" required /></label>
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

function successPage(submission: TestJobSubmission): string {
	return page("Application Received", `
    <main>
      <section class="success">
        <p class="eyebrow">Success</p>
        <h1>Application received</h1>
        <p id="application-id">${escapeHtml(submission.id)}</p>
        <p>Thank you, ${escapeHtml(submission.fields.fullName || "candidate")}.</p>
        <p>Resume: ${escapeHtml(submission.resume?.filename || "missing")} (${submission.resume?.size || 0} bytes)</p>
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
    .job, .success, form { background: white; border: 1px solid #d7dee8; border-radius: 8px; padding: 24px; }
    .application-form { display: grid; gap: 16px; margin-top: 20px; }
    label { display: grid; gap: 6px; font-weight: 650; }
    input, select, textarea { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #aab6c4; border-radius: 6px; font: inherit; }
    button { width: fit-content; padding: 10px 16px; border: 0; border-radius: 6px; background: #166534; color: white; font-weight: 700; cursor: pointer; }
    .eyebrow { color: #4f46e5; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .company { font-weight: 700; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function parseApplication(req: IncomingMessage): Promise<TestJobSubmission> {
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
		const contentType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
		if (name && filename) {
			files[name] = {
				filename,
				contentType,
				size: body.length,
			};
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
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
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
