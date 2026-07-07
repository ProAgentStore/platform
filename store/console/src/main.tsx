import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isConnectivityError, reportClientError } from "@proagentstore/sdk/client";
import App from "./App";
import "./index.css";

// Full observability: mirror uncaught browser errors + unhandled promise rejections
// into the durable server error log so they're visible via MCP list_errors, not just
// in the user's DevTools. Best-effort + deduped inside reportClientError.
window.addEventListener("error", (e) => {
	const msg = e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.message || "error");
	// An uncaught fetch that hit a network blip surfaces here as "TypeError: Load failed";
	// it's transient connectivity, not a bug — suppress it so it can't flood the log
	// (the same class api() already skips, via the shared predicate).
	if (isConnectivityError(msg)) return;
	reportClientError("window", msg, { file: e.filename, line: e.lineno, col: e.colno, stack: e.error instanceof Error ? String(e.error.stack || "").slice(0, 600) : undefined });
});
window.addEventListener("unhandledrejection", (e) => {
	const r = e.reason;
	const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r);
	if (isConnectivityError(msg)) return;
	reportClientError("unhandledrejection", msg, { stack: r instanceof Error ? String(r.stack || "").slice(0, 600) : undefined });
});

// Apply saved text scale before paint
try {
	const s = parseFloat(localStorage.getItem("pags:textScale") || "");
	if (s && s >= 0.8 && s <= 1.5)
		document.documentElement.style.fontSize = `${s * 100}%`;
} catch {
	/* ignore */
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
