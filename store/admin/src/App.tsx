import { useEffect, useState } from "react";
import { BarChart3, LayoutDashboard, Users as UsersIcon } from "lucide-react";
import { api, captureOAuthSession, getToken, signIn } from "./lib/api";
import Overview from "./pages/Overview";
import Users from "./pages/Users";
import Spending from "./pages/Spending";

type Nav = "overview" | "users" | "spending";
const NAV: Array<{ id: Nav; label: string; icon: typeof LayoutDashboard }> = [
	{ id: "overview", label: "Overview", icon: LayoutDashboard },
	{ id: "users", label: "Users", icon: UsersIcon },
	{ id: "spending", label: "Spending", icon: BarChart3 },
];

type Gate = "loading" | "anon" | "denied" | "ok";

function navFromHash(): Nav {
	const h = window.location.hash.replace(/^#\/?/, "");
	return (NAV.find((n) => n.id === h)?.id) || "overview";
}

export default function App() {
	const [gate, setGate] = useState<Gate>("loading");
	const [nav, setNav] = useState<Nav>(navFromHash());

	useEffect(() => {
		captureOAuthSession();
		if (!getToken()) { setGate("anon"); return; }
		api<{ admin: boolean }>("/v1/admin/me")
			.then((r) => setGate(r.admin ? "ok" : "denied"))
			.catch(() => setGate("anon"));
	}, []);

	useEffect(() => {
		const onHash = () => setNav(navFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
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
		<div>
			<header className="sticky top-0 z-40 h-12 px-4 flex items-center gap-4 border-b border-line bg-paper">
				<span className="font-display font-bold text-red">⚡ Admin</span>
				<nav className="flex gap-1 ml-2">
					{NAV.map((n) => {
						const Icon = n.icon;
						const active = nav === n.id;
						return (
							<a
								key={n.id}
								href={`#/${n.id}`}
								className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${active ? "bg-accent-soft text-accent" : "text-muted hover:text-ink hover:bg-panel-hover"}`}
							>
								<Icon size={15} /> <span className="hidden sm:inline">{n.label}</span>
							</a>
						);
					})}
				</nav>
				<a href="/console/" className="ml-auto text-sm text-muted hover:text-ink">Console →</a>
			</header>
			<main className="max-w-5xl mx-auto p-4">
				{nav === "overview" && <Overview />}
				{nav === "users" && <Users />}
				{nav === "spending" && <Spending />}
			</main>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="min-h-dvh flex items-center justify-center p-6 text-sm">{children}</div>;
}
