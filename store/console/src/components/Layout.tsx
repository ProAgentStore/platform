import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../lib/AuthContext";
import { useNavHidden, useHeaderSlotContent } from "../lib/HeaderContext";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import { Zap, Bell, Menu, BellRing, X, Bot, Library, Server, BarChart3, Wrench, Terminal, Gauge } from "lucide-react";
import { pushPermission, pushSupported, ensurePushSubscribed, enablePush } from "../lib/push";

const navItems = [
	{ to: "/agents", label: "My Agents", icon: Bot },
	{ to: "/browse", label: "Library", icon: Library },
	{ to: "/instances", label: "Instances", icon: Server },
	{ to: "/terminals", label: "Terminals", icon: Terminal },
	{ to: "/usage", label: "Usage", icon: Gauge },
	{ to: "/dashboard", label: "Stats", icon: BarChart3 },
	{ to: "/tools", label: "Tools", icon: Wrench },
] as const;

export default function Layout() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	const [unreadCount, setUnreadCount] = useState(0);
	const menuRef = useRef<HTMLElement>(null);
	const navHidden = useNavHidden();
	const headerSlot = useHeaderSlotContent();

	useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("click", handler, true);
		return () => document.removeEventListener("click", handler, true);
	}, [menuOpen]);

	const loadBadge = useCallback(async () => {
		if (!user) return;
		try {
			const d = await api<{ unreadCount?: number }>("/v1/notifications?unread=true&limit=1");
			setUnreadCount(d.unreadCount || 0);
		} catch {}
	}, [user]);

	useEffect(() => { loadBadge(); }, [loadBadge]);
	usePolling(loadBadge, 30000, !!user);

	return (
		<div className="flex flex-col h-dvh overflow-hidden">
			{/* Denser in instance view (navHidden): every px of chrome is space the chat
			    loses — tighter gaps, slimmer bar, icon-only logo on mobile. */}
			<header className={`border-b border-line-strong bg-panel z-60 flex items-center shrink-0 ${navHidden ? "gap-1.5 px-2 h-10" : "gap-2 px-3 h-12"}`} style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.4)" }}>
				{/* Logo — always visible */}
				<a
					href="/console/"
					onClick={(e) => {
						e.preventDefault();
						navigate("/");
					}}
					className="flex items-center gap-1.5 no-underline text-ink shrink-0"
				>
					<span className={`rounded-lg bg-gradient-to-br from-accent to-indigo-500 flex items-center justify-center text-sm ${navHidden ? "w-6 h-6" : "w-7 h-7"}`}>
						<Zap size={navHidden ? 14 : 16} />
					</span>
					<span className="font-display font-bold text-[0.95rem] hidden sm:inline">
						ProAgentStore
					</span>
				</a>

				{/* Nav links — hidden when instance detail injects its controls */}
				{!navHidden && (
					<>
						<nav className="flex items-center gap-0.5 shrink-0 min-w-0" aria-label="Primary">
							{navItems.map(({ to, label, icon: Icon }) => (
								<NavLink
									key={to}
									to={to}
									title={label}
									aria-label={label}
									className={({ isActive }) => `h-8 w-7 sm:w-8 lg:w-auto lg:h-auto lg:px-2.5 px-0 py-1.5 rounded-md no-underline whitespace-nowrap transition-all flex items-center justify-center gap-1.5 text-[0.82rem] ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}
								>
									<Icon size={15} className="shrink-0" />
									<span className="hidden lg:inline">{label}</span>
								</NavLink>
							))}
						</nav>
						<div className="flex-1 min-w-0" />
					</>
				)}

				{/* Instance controls injected via useHeaderSlot */}
				{navHidden && headerSlot && (
					<div className="min-w-0 flex-1">
						{headerSlot}
					</div>
				)}

				{/* Right: notifications + avatar — always visible */}
				{user && (
					<span className={`flex items-center shrink-0 ${navHidden ? "gap-1.5" : "gap-2.5"}`}>
						<NavLink to="/notifications" className="relative no-underline text-muted" title="Notifications">
							<Bell size={navHidden ? 16 : 18} />
							{unreadCount > 0 && (
								<span className="absolute -top-1 -right-1.5 bg-red text-white text-[0.55rem] w-4 h-4 rounded-full flex items-center justify-center font-bold leading-none">
									{unreadCount > 9 ? "9+" : unreadCount}
								</span>
							)}
						</NavLink>
						<NavLink to="/profile" className="flex items-center text-muted no-underline hover:text-ink">
							<img src={user.avatar} alt="" className={`rounded-full border-2 border-line ${navHidden ? "w-[22px] h-[22px]" : "w-[26px] h-[26px]"}`} />
						</NavLink>
					</span>
				)}

				{/* Hamburger — only when default nav is showing */}
				{!navHidden && (
					<button
						type="button"
						className="lg:hidden shrink-0 text-xl text-muted hover:text-ink hover:bg-line rounded-md px-1.5 py-1"
						onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
						aria-label="Open menu"
					>
						<Menu size={20} />
					</button>
				)}
				{!navHidden && menuOpen && (
					<nav
						ref={menuRef}
						className="lg:hidden absolute top-[50px] right-2 flex flex-col items-stretch bg-panel border border-line rounded-xl p-1 min-w-48 shadow-lg z-80"
						aria-label="Menu"
					>
						{navItems.map(({ to, label, icon: Icon }) => (
							<NavLink
								key={to}
								to={to}
								onClick={() => setMenuOpen(false)}
								className={({ isActive }) => `text-[0.82rem] px-2.5 py-2 rounded-md no-underline whitespace-nowrap transition-all flex items-center gap-2 ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}
							>
								<Icon size={15} className="shrink-0" />
								{label}
							</NavLink>
						))}
					</nav>
				)}
			</header>
			{user && <PushPrompt />}
			<main className={`flex-1 min-h-0 flex flex-col ${navHidden ? "overflow-hidden" : "overflow-auto"}`}>
				<Outlet />
			</main>
		</div>
	);
}

/**
 * Enrols the browser for web-push so the agent can actually reach the user (e.g.
 * "your application needs an answer") instead of the notice sitting silently in the
 * bell. If permission is already granted, it re-subscribes on load and shows nothing.
 * If it's never been asked, it shows a one-tap banner (permission needs a gesture).
 */
function PushPrompt() {
	const [perm, setPerm] = useState<string>(() => pushPermission());
	const [dismissed, setDismissed] = useState<boolean>(() => localStorage.getItem("pags:push-dismissed") === "1");
	const [busy, setBusy] = useState(false);

	useEffect(() => { void ensurePushSubscribed(); }, []);

	if (!pushSupported() || perm === "granted" || perm === "denied" || dismissed) return null;

	const onEnable = async () => {
		setBusy(true);
		const res = await enablePush();
		setBusy(false);
		setPerm(pushPermission());
		if (res === "denied") { setDismissed(true); localStorage.setItem("pags:push-dismissed", "1"); }
	};
	const onDismiss = () => { setDismissed(true); localStorage.setItem("pags:push-dismissed", "1"); };

	return (
		<div className="shrink-0 bg-accent/10 border-b border-accent/25 px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
			<BellRing size={18} className="text-accent shrink-0" />
			<div className="text-sm text-ink flex-1 min-w-[8rem]">
				<b>Turn on alerts</b> so your agent can reach you the moment it needs an answer — even when this tab is closed.
			</div>
			<button type="button" onClick={onEnable} disabled={busy} className="order-2 sm:order-none px-4 py-2 rounded-lg bg-accent text-white text-sm font-bold disabled:opacity-50 shrink-0 whitespace-nowrap">
				{busy ? "Enabling…" : "🔔 Enable alerts"}
			</button>
			<button type="button" onClick={onDismiss} className="text-muted hover:text-ink shrink-0 order-3 sm:order-none" aria-label="Dismiss"><X size={16} /></button>
		</div>
	);
}
