import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../lib/AuthContext";
import { useNavHidden, useHeaderSlotContent } from "../lib/HeaderContext";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";
import { Zap, Bell, Menu } from "lucide-react";

export default function Layout() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	const [unreadCount, setUnreadCount] = useState(0);
	const navRef = useRef<HTMLElement>(null);
	const navHidden = useNavHidden();
	const headerSlot = useHeaderSlotContent();

	useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			if (navRef.current && !navRef.current.contains(e.target as Node)) {
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
			<header className="border-b border-line-strong bg-panel z-60 flex items-center gap-2 px-3 h-12 shrink-0" style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.4)" }}>
				{/* Logo — always visible */}
				<a
					href="/console/"
					onClick={(e) => {
						e.preventDefault();
						navigate("/");
					}}
					className="flex items-center gap-1.5 no-underline text-ink shrink-0"
				>
					<span className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-indigo-500 flex items-center justify-center text-sm">
						<Zap size={16} />
					</span>
					<span className="font-display font-bold text-[0.95rem] hidden sm:inline">
						PAGS
					</span>
				</a>

				{/* Nav links — hidden when instance detail injects its controls */}
				{!navHidden && (
					<>
						<nav
							ref={navRef}
							className={`items-center gap-0.5 shrink-0 ${
								menuOpen
									? "flex max-lg:absolute max-lg:top-[50px] max-lg:right-2 max-lg:flex-col max-lg:items-stretch max-lg:bg-panel max-lg:border max-lg:border-line max-lg:rounded-xl max-lg:p-1 max-lg:min-w-48 max-lg:shadow-lg max-lg:z-80"
									: "hidden lg:flex"
							}`}
						>
							<NavLink to="/agents" className={({ isActive }) => `text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}>
								Agents
							</NavLink>
							<NavLink to="/instances" className={({ isActive }) => `text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}>
								Instances
							</NavLink>
							<NavLink to="/dashboard" className={({ isActive }) => `text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}>
								Stats
							</NavLink>
						</nav>
						<div className="flex-1" />
					</>
				)}

				{/* Instance controls injected via useHeaderSlot */}
				{navHidden && headerSlot && (
					<>
						{headerSlot}
						<div className="flex-1" />
					</>
				)}

				{/* Right: notifications + avatar — always visible */}
				{user && (
					<span className="flex items-center gap-2.5 shrink-0">
						<NavLink to="/notifications" className="relative no-underline text-muted" title="Notifications">
							<Bell size={18} />
							{unreadCount > 0 && (
								<span className="absolute -top-1 -right-1.5 bg-red text-white text-[0.55rem] w-4 h-4 rounded-full flex items-center justify-center font-bold leading-none">
									{unreadCount > 9 ? "9+" : unreadCount}
								</span>
							)}
						</NavLink>
						<NavLink to="/profile" className="flex items-center text-muted no-underline hover:text-ink">
							<img src={user.avatar} alt="" className="w-[26px] h-[26px] rounded-full border-2 border-line" />
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
			</header>
			<main className={`flex-1 min-h-0 flex flex-col ${navHidden ? "overflow-hidden" : "overflow-auto"}`}>
				<Outlet />
			</main>
		</div>
	);
}
