// Development-only Playwright fixture. This is not a Console route or production entry point.
// It mounts the real RunDetail page for one application card; every API call is Playwright's mock.
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RunDetail from "./RunDetail";
import "../index.css";

const task = new URLSearchParams(location.search).get("task") ?? "app-1";

createRoot(document.getElementById("root")!).render(
	<MemoryRouter initialEntries={[`/instances/instance-1/tasks/${task}`]}>
		<Routes>
			<Route path="/instances/:id/tasks/:taskId" element={<RunDetail />} />
		</Routes>
	</MemoryRouter>,
);
