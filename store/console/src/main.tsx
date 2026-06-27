import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

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
