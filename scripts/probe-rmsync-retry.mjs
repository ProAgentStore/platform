// Diagnostic for #1727: does fs.rmSync's maxRetries/retryDelay wait out a directory that a live process holds as its cwd?
// A child lives in the directory for HOLD_MS; rmSync is asked to retry for far longer than that. Prints how it ended and when.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOLD_MS = 5000;
const dir = mkdtempSync(join(tmpdir(), "pags-probe-"));
const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${HOLD_MS})`], { cwd: dir, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500)); // let it start
const t0 = Date.now();
try {
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	console.log(`node ${process.version} ${process.platform}: removed after ${Date.now() - t0} ms (child held it ${HOLD_MS} ms)`);
} catch (e) {
	console.log(`node ${process.version} ${process.platform}: ${e.code} after ${Date.now() - t0} ms (child held it ${HOLD_MS} ms, retries asked for ~52 s)`);
}
child.kill();
await new Promise((r) => setTimeout(r, 500));
rmSync(dir, { recursive: true, force: true });
