import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { HeaderProvider } from "./lib/HeaderContext";
import { ConversationProvider } from "./lib/ConversationContext";
import ErrorBoundary from "./components/ErrorBoundary";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Browse from "./pages/Browse";
import AgentDetail from "./pages/AgentDetail";
import InstanceDetail from "./pages/InstanceDetail";
import Profile from "./pages/Profile";
import Notifications from "./pages/Notifications";
import Terminals from "./pages/Terminals";
import Usage from "./pages/Usage";
import Feedback from "./pages/Feedback";
import Preferences from "./pages/Preferences";
import RunDetail from "./pages/RunDetail";
import { landingRoute, landingRouteFromMemory, type TopLevelRoute } from "./lib/lastRoute";
import { readLandingCounts } from "./lib/landing";

/**
 * Root/unknown-path redirect: restore the last visited top-level screen (#161), else send the
 * user to what they actually HAVE — Instances, then My Agents, then the Library (#794).
 *
 * A remembered section answers with no request at all, which covers every reload for an
 * established user. Only a cold start — or a remembered `browse`, the one section `lastRoute.ts`
 * deliberately does not restore to — pays a round trip, and it asks the same two endpoints the
 * destination page loads on mount anyway.
 *
 * The interim state is a spinner and not a redirect-then-correct: bouncing the user off a page
 * they were never meant to see rewrites history, and on a slow connection it is visible.
 */
function DefaultRedirect() {
	const [to, setTo] = useState<TopLevelRoute | null>(landingRouteFromMemory);

	useEffect(() => {
		if (to) return;
		let live = true;
		(async () => {
			const counts = await readLandingCounts();
			if (live) setTo(landingRoute(null, counts));
		})();
		return () => { live = false; };
	}, [to]);

	if (!to) {
		return (
			<div className="flex items-center justify-center min-h-[80dvh]">
				<div className="text-muted text-sm">Loading...</div>
			</div>
		);
	}
	return <Navigate to={to} replace />;
}

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

	// Inside the router (it navigates) and outside the routes (it must survive them): the
	// conversation you are in is a property of the APP, not of the instance page (#278).
	return (
		<ConversationProvider>
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<DefaultRedirect />} />
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
				<Route path="usage" element={<Usage />} />
				<Route path="feedback" element={<Feedback />} />
				<Route path="preferences" element={<Preferences />} />
				<Route path="profile" element={<Profile />} />
				<Route path="notifications" element={<Notifications />} />
				<Route path="*" element={<DefaultRedirect />} />
			</Route>
		</Routes>
		</ConversationProvider>
	);
}

function consoleBasename() {
	return window.location.hostname === "console.proagentstore.online"
		? "/"
		: "/console";
}

export default function App() {
	return (
		<ErrorBoundary>
			<AuthProvider>
				<HeaderProvider>
					<BrowserRouter basename={consoleBasename()}>
						<Routes>
							<Route path="/*" element={<AuthGate />} />
						</Routes>
					</BrowserRouter>
				</HeaderProvider>
			</AuthProvider>
		</ErrorBoundary>
	);
}
