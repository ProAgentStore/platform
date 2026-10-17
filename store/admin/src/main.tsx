import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { classifyClientFailure, setClientBuild } from "@proagentstore/sdk/client";
import { reportClientError } from "./lib/api";
import "./index.css";

// Every error row this app files names its build (#539) — before #1120 it reported `unset`.
setClientBuild(__BUILD__);

// Mirror uncaught browser errors into the durable log so admin-app crashes are visible (they'd otherwise
// be a silent blank page). Classified (#1088), not filtered by words: an abort or offline failure is
// expected; an uncaught fetch failure while online is a `network` warning; opaque cross-origin
// "Script error." carries nothing actionable.
function reportUncaught(source: string, err: unknown, msg: string, context: Record<string, unknown>) {
	const kind = classifyClientFailure(err);
	if (kind === "abort" || kind === "offline") return;
	reportClientError(kind === "network" ? "network" : source, msg, context);
}
window.addEventListener("error", (e) => {
	const msg = e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.message || "error");
	if (/^Script error\.?$/.test(msg) && !e.filename) return;
	reportUncaught("window", e.error, msg, { file: e.filename, line: e.lineno, stack: e.error instanceof Error ? String(e.error.stack || "").slice(0, 600) : undefined });
});
window.addEventListener("unhandledrejection", (e) => {
	const r = e.reason;
	reportUncaught("unhandledrejection", r, r instanceof Error ? `${r.name}: ${r.message}` : String(r), { stack: r instanceof Error ? String(r.stack || "").slice(0, 600) : undefined });
});

// The admin app has no error boundary: a render error is reported here, once (#1088). Supplying the
// handler replaces React's default `reportError`, so the window handler above does not see it twice.
createRoot(document.getElementById("root")!, {
	onUncaughtError: (error, info) => {
		const e = error instanceof Error ? error : new Error(String(error));
		reportClientError("react", `${e.name}: ${e.message}`, { stack: String(e.stack || "").slice(0, 600), componentStack: String(info.componentStack || "").slice(0, 600) });
		console.error(error);
	},
}).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
