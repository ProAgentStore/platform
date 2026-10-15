import type { IncomingMessage } from "node:http";
import { type CrashLog, crashReport, describeError, runtimeCrashIdentity } from "./crash-reports.js";

/**
 * A request that failed on the runtime's side (5xx), as a crash report (#1087): method, path and the
 * correlation ids the URL and headers carry — the instance header, a `/tasks/:id`, a `/sessions/:id`.
 * Never the body. Called from the server's one request boundary.
 */
export function recordRequestFailure(log: CrashLog, req: IncomingMessage, error: unknown): void {
	const path = (req.url || "").split("?")[0];
	const instance = req.headers["x-pags-instance-id"];
	log.record(
		crashReport({
			...runtimeCrashIdentity(),
			kind: "request_failure",
			...describeError(error),
			route: `${req.method ?? "?"} ${path}`,
			instanceId: typeof instance === "string" ? instance : undefined,
			taskId: /\/tasks\/([^/]+)/.exec(path)?.[1],
			sessionId: /\/sessions\/([^/]+)/.exec(path)?.[1],
		}),
	);
}
