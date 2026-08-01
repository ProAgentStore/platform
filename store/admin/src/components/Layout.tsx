import { NavLink, Outlet } from "react-router-dom";
import { Activity, AlertTriangle, BarChart3, Bot, Boxes, Gauge, LayoutDashboard, Plug, ScrollText, Siren, TerminalSquare, Users as UsersIcon, Zap } from "lucide-react";

const NAV = [
	{ to: "/", label: "Overview", icon: LayoutDashboard, end: true },
	{ to: "/ops", label: "Ops", icon: Siren },
	{ to: "/errors", label: "Errors", icon: AlertTriangle },
	{ to: "/users", label: "Users", icon: UsersIcon },
	{ to: "/agents", label: "Agents", icon: Bot },
	{ to: "/instances", label: "Instances", icon: Boxes },
	{ to: "/terminals", label: "Terminals", icon: TerminalSquare },
	{ to: "/connectors", label: "Connectors", icon: Plug },
	{ to: "/triggers", label: "Triggers", icon: Zap },
	{ to: "/usage", label: "Usage", icon: Gauge },
	{ to: "/spending", label: "Spending", icon: BarChart3 },
	{ to: "/mcp-audit", label: "MCP audit", icon: ScrollText },
	{ to: "/audit", label: "Audit", icon: Activity },
];

export default function Layout() {
	return (
		<div className="min-h-dvh md:flex">
			<aside className="md:w-52 md:h-dvh md:sticky md:top-0 border-b md:border-b-0 md:border-r border-line bg-panel md:flex md:flex-col">
				<div className="px-4 h-12 flex items-center gap-2 border-b border-line">
					<span className="text-red font-display font-bold">⚡ Admin</span>
				</div>
				<nav className="flex md:flex-col gap-0.5 p-2 overflow-x-auto">
					{NAV.map((n) => {
						const Icon = n.icon;
						return (
							<NavLink
								key={n.to}
								to={n.to}
								end={n.end}
								className={({ isActive }) =>
									`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
										isActive ? "bg-accent-soft text-accent" : "text-muted hover:text-ink hover:bg-panel-hover"
									}`
								}
							>
								<Icon size={16} /> <span>{n.label}</span>
							</NavLink>
						);
					})}
				</nav>
				<a href="/console/" className="hidden md:block mt-auto p-3 text-xs text-muted hover:text-ink border-t border-line">← Console</a>
			</aside>
			<main className="flex-1 min-w-0 p-4 md:p-6 max-w-6xl">
				<Outlet />
			</main>
		</div>
	);
}
