import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../lib/AuthContext";
import { api } from "../lib/api";
import { usePolling } from "../hooks/usePolling";

export default function Layout() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	const [unreadCount, setUnreadCount] = useState(0);
	const navRef = useRef<HTMLElement>(null);

	// Close menu on outside click
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

	// Poll notification badge
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
		<>
			<header className="border-b border-line-strong bg-panel sticky top-0 z-60 flex items-center gap-2.5 px-3 h-12" style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.4)" }}>
				<a
					href="/console/"
					onClick={(e) => {
						e.preventDefault();
						navigate("/");
					}}
					className="flex items-center gap-1.5 no-underline text-ink shrink-0"
				>
					<span className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-indigo-500 flex items-center justify-center text-sm">
						&#9889;
					</span>
					<span className="font-display font-bold text-[0.95rem] hidden sm:inline">
						PAGS
					</span>
				</a>

				<nav
					ref={navRef}
					className={`items-center gap-0.5 shrink-0 ${
						menuOpen
							? "flex max-lg:absolute max-lg:top-[50px] max-lg:right-2 max-lg:flex-col max-lg:items-stretch max-lg:bg-panel max-lg:border max-lg:border-line max-lg:rounded-xl max-lg:p-1 max-lg:min-w-48 max-lg:shadow-lg max-lg:z-80"
							: "hidden lg:flex"
					}`}
				>
					<NavLink
						to="/agents"
						className={({ isActive }) =>
							`text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`
						}
					>
						Agents
					</NavLink>
					<NavLink
						to="/instances"
						className={({ isActive }) =>
							`text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`
						}
					>
						Instances
					</NavLink>
					<NavLink
						to="/dashboard"
						className={({ isActive }) =>
							`text-[0.82rem] px-2.5 py-1.5 rounded-md no-underline whitespace-nowrap transition-all ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`
						}
					>
						Stats
					</NavLink>
				</nav>

				{/* Spacer */}
				<div className="flex-1" />

				{/* User nav */}
				{user && (
					<span className="flex items-center gap-2.5 ml-auto">
						<NavLink
							to="/notifications"
							className="relative no-underline text-[1.1rem] text-muted"
							title="Notifications"
						>
							&#128276;
							{unreadCount > 0 && (
								<span className="absolute -top-1 -right-1.5 bg-red text-white text-[0.55rem] w-4 h-4 rounded-full flex items-center justify-center font-bold leading-none">
									{unreadCount > 9 ? "9+" : unreadCount}
								</span>
							)}
						</NavLink>
						<NavLink
							to="/profile"
							className="flex items-center gap-1.5 text-[0.82rem] text-muted no-underline hover:text-ink"
						>
							<img
								src={user.avatar}
								alt=""
								className="w-[26px] h-[26px] rounded-full border-2 border-line"
							/>
						</NavLink>
					</span>
				)}

				{/* Hamburger */}
				<button
					type="button"
					className="lg:hidden shrink-0 text-xl text-muted hover:text-ink hover:bg-line rounded-md px-1.5 py-1"
					onClick={(e) => {
						e.stopPropagation();
						setMenuOpen(!menuOpen);
					}}
					aria-label="Open menu"
				>
					&#9776;
				</button>
			</header>
			<Outlet />
		</>
	);
}
