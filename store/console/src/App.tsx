import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { HeaderProvider } from "./lib/HeaderContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Browse from "./pages/Browse";
import AgentDetail from "./pages/AgentDetail";
import InstanceDetail from "./pages/InstanceDetail";
import Profile from "./pages/Profile";
import Notifications from "./pages/Notifications";
import Terminals from "./pages/Terminals";
import RunDetail from "./pages/RunDetail";

function AuthGate() {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-[80dvh]">
				<div className="text-muted text-sm">Loading...</div>
			</div>
		);
	}

	if (!user) return <Login />;

	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="agents" replace />} />
				<Route path="agents" element={<Dashboard />} />
				<Route path="browse" element={<Browse />} />
				<Route path="agents/new" element={<AgentDetail />} />
				<Route path="agents/:id" element={<AgentDetail />} />
				<Route path="agents/:id/:tab" element={<AgentDetail />} />
				<Route path="instances" element={<Dashboard />} />
				<Route path="instances/:id/tasks/:taskId" element={<RunDetail />} />
				<Route path="instances/:id/*" element={<InstanceDetail />} />
				<Route path="dashboard" element={<Dashboard />} />
				<Route path="tools" element={<Dashboard />} />
				<Route path="terminals" element={<Terminals />} />
				<Route path="profile" element={<Profile />} />
				<Route path="notifications" element={<Notifications />} />
				<Route path="*" element={<Navigate to="agents" replace />} />
			</Route>
		</Routes>
	);
}

function consoleBasename() {
	return window.location.hostname === "console.proagentstore.online"
		? "/"
		: "/console";
}

export default function App() {
	return (
		<AuthProvider>
			<HeaderProvider>
				<BrowserRouter basename={consoleBasename()}>
					<Routes>
						<Route path="/*" element={<AuthGate />} />
					</Routes>
				</BrowserRouter>
			</HeaderProvider>
		</AuthProvider>
	);
}
