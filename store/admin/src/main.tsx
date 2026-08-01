import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { reportClientError } from "./lib/api";
import "./index.css";

// Mirror uncaught browser errors into the durable log so admin-app crashes are
// visible (they'd otherwise be a silent blank page). Skip opaque cross-origin
// "Script error." (no actionable detail) and transient "Load failed" connectivity.
window.addEventListener("error", (e) => {
	const msg = e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.message || "error");
	if (/^Script error\.?$/.test(msg) && !e.filename) return;
	if (/Load failed|NetworkError|Failed to fetch/i.test(msg)) return;
	reportClientError("window", msg, { file: e.filename, line: e.lineno, stack: e.error instanceof Error ? String(e.error.stack || "").slice(0, 600) : undefined });
});
window.addEventListener("unhandledrejection", (e) => {
	const r = e.reason;
	const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r);
	if (/Load failed|NetworkError|Failed to fetch/i.test(msg)) return;
	reportClientError("unhandledrejection", msg, { stack: r instanceof Error ? String(r.stack || "").slice(0, 600) : undefined });
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
