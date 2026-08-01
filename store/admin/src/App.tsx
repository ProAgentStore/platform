import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { api, captureOAuthSession, getToken, signIn } from "./lib/api";
import Layout from "./components/Layout";
import Overview from "./pages/Overview";
import Errors from "./pages/Errors";
import Users from "./pages/Users";
import UserDetail from "./pages/UserDetail";
import Agents from "./pages/Agents";
import AgentDetail from "./pages/AgentDetail";
import Instances from "./pages/Instances";
import Terminals from "./pages/Terminals";
import Connectors from "./pages/Connectors";
import ConnectorDetail from "./pages/ConnectorDetail";
import Usage from "./pages/Usage";
import Spending from "./pages/Spending";
import Audit from "./pages/Audit";
import InstanceDetail from "./pages/InstanceDetail";
import TraceView from "./pages/TraceView";
import SessionDetail from "./pages/SessionDetail";
import McpAudit from "./pages/McpAudit";
import Ops from "./pages/Ops";
import Triggers from "./pages/Triggers";
import ErrorSignature from "./pages/ErrorSignature";

type Gate = "loading" | "anon" | "denied" | "ok";

export default function App() {
	const [gate, setGate] = useState<Gate>("loading");

	useEffect(() => {
		captureOAuthSession();
		if (!getToken()) { setGate("anon"); return; }
		api<{ admin: boolean }>("/v1/admin/me")
			.then((r) => setGate(r.admin ? "ok" : "denied"))
			.catch(() => setGate("anon"));
	}, []);

	if (gate === "loading") return <Centered>Checking admin access…</Centered>;
	if (gate === "anon") return (
		<Centered>
			<div className="space-y-3 text-center">
				<p className="text-muted">Sign in to access the operator console.</p>
				<div className="flex gap-2 justify-center">
					<button onClick={() => signIn("google")} className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-semibold">Sign in with Google</button>
					<button onClick={() => signIn("github")} className="px-4 py-2 rounded-lg border border-line hover:bg-panel-hover text-sm font-semibold">GitHub</button>
				</div>
			</div>
		</Centered>
	);
	if (gate === "denied") return <Centered><span className="text-red">Admin access required.</span></Centered>;

	return (
		<BrowserRouter basename="/admin">
			<Routes>
				<Route element={<Layout />}>
					<Route index element={<Overview />} />
					<Route path="errors" element={<Errors />} />
					<Route path="errors/:key" element={<ErrorSignature />} />
					<Route path="users" element={<Users />} />
					<Route path="users/:id" element={<UserDetail />} />
					<Route path="agents" element={<Agents />} />
					<Route path="agents/:id" element={<AgentDetail />} />
					<Route path="instances" element={<Instances />} />
					<Route path="instances/:id" element={<InstanceDetail />} />
					<Route path="instances/:instanceId/trace" element={<TraceView />} />
					<Route path="terminals" element={<Terminals />} />
					<Route path="coding-sessions/:sid" element={<SessionDetail />} />
					<Route path="connectors" element={<Connectors />} />
					<Route path="connectors/:connector" element={<ConnectorDetail />} />
					<Route path="ops" element={<Ops />} />
					<Route path="triggers" element={<Triggers />} />
					<Route path="mcp-audit" element={<McpAudit />} />
					<Route path="usage" element={<Usage />} />
					<Route path="spending" element={<Spending />} />
					<Route path="audit" element={<Audit />} />
					<Route path="*" element={<Overview />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="min-h-dvh flex items-center justify-center p-6 text-sm">{children}</div>;
}
