import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A download belongs to one agent/run/reference, never to its server-supplied filename. */
export class ResumeFiles {
	private readonly files = new Map<string, string>();
	async resolve(ref: string, agentDir: string, taskId?: string): Promise<string | null> {
		if (!/^https?:\/\//i.test(ref)) return existsSync(resolve(ref)) ? resolve(ref) : null;
		const key = createHash("sha256").update(JSON.stringify([agentDir, taskId ?? null, ref])).digest("hex");
		const cached = this.files.get(key);
		if (cached && existsSync(cached)) return cached;
		try {
			const response = await fetch(ref);
			if (!response.ok) return null;
			const body = Buffer.from(await response.arrayBuffer());
			const disposition = response.headers.get("content-disposition") || "";
			const supplied = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "resume.pdf";
			const name = supplied.replace(/[^\w.-]/g, "_").replace(/^\.+$/, "resume.pdf");
			const directory = join(agentDir, "uploads", key);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const destination = join(directory, name);
			writeFileSync(destination, body, { mode: 0o600 });
			this.files.set(key, destination);
			return destination;
		} catch {
			return null;
		}
	}
}
