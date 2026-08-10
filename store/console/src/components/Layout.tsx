import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../lib/AuthContext";
import { useNavHidden, useHeaderSlotContent } from "../lib/HeaderContext";
import ErrorBoundary from "./ErrorBoundary";
import ConversationPill from "./ConversationPill";
import Button from "./Button";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { Zap, Bell, Menu, BellRing, X, Bot, Library, Server, BarChart3, Wrench, Terminal, Gauge, SlidersHorizontal } from "lucide-react";
import { pushPermission, pushSupported, ensurePushSubscribed, enablePush } from "../lib/push";
import { isSuppressedPush } from "../lib/pushMessages";
import { rememberRoute } from "../lib/lastRoute";

const navItems = [
	{ to: "/agents", label: "My Agents", icon: Bot },
	{ to: "/browse", label: "Library", icon: Library },
	{ to: "/instances", label: "Instances", icon: Server },
	{ to: "/terminals", label: "Terminals", icon: Terminal },
	{ to: "/usage", label: "Usage", icon: Gauge },
	{ to: "/dashboard", label: "Stats", icon: BarChart3 },
	{ to: "/tools", label: "Tools", icon: Wrench },
	// How YOU speak, hear and read — across every agent (#211). Deliberately NOT on Profile:
	// that page is identity and money; this one is behaviour.
	{ to: "/preferences", label: "Preferences", icon: SlidersHorizontal },
] as const;

export default function Layout() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
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
		} catch {
			// IGNORABLE (#291): a bell badge is an at-a-glance hint, not a record, and it re-loads.
			// The Notifications page it points at now reports its OWN read failure, so the place
			// where a missing count would actually mislead someone is covered — putting an error
			// state in the global header for it would follow the user onto every screen.
		}
	}, [user]);

	useEffect(() => { loadBadge(); }, [loadBadge]);
	// The bell badge is the IN-APP half of a notification; Web Push is the other half, and the
	// service worker already suppresses a push while a console tab is visible (#176). So the two
	// are exact complements: while you are looking, this poll is what tells you; while you are
	// not, the OS notification is — and this poll has nothing to do but spend battery. Hence no
	// busy tier and a hard halt when hidden, plus the catch-up fetch on return so the count is
	// right the instant the tab is back. A push that arrives while you ARE looking now nudges
	// this same fetch through the service-worker message below, so nothing waits out the 30s.
	useTieredPolling(loadBadge, { activeMs: 30000, passiveMs: 30000 }, false, !!user);

	// A push the service worker suppressed because this tab is on screen (#176). It forwards the
	// payload rather than dropping it, so the thing the user would have been told about shows up
	// in the app immediately instead of up to 30s later.
	useEffect(() => {
		if (!user || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
		const onMessage = (e: MessageEvent) => { if (isSuppressedPush(e.data)) void loadBadge(); };
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, [user, loadBadge]);

	// Remember the last visited top-level screen so a reload/re-open restores it (#161).
	useEffect(() => { rememberRoute(location.pathname); }, [location.pathname]);

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
					<span className="font-display font-bold text-base hidden sm:inline">
						ProAgentStore
					</span>
				</a>

				{/* Nav links — hidden when instance detail injects its controls */}
				{!navHidden && (
					<>
						{/* Below sm the strip is HIDDEN, not scrolled (#235).
						    Eight destinations never fit a phone header, so `overflow-x-auto` meant the
						    bar panned by 25px at 375 and 80px at 320 — which is what users reported as
						    "the page scrolls sideways", even though neither the document nor <main>
						    ever overflowed. It was also redundant: the hamburger beside it already
						    lists exactly these items, with labels. From sm up they fit, so they stay.
						    The spacer keeps the avatar/menu cluster pinned right without it. */}
						<div className="flex-1 sm:hidden" />
						<nav className="hidden sm:flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-none" aria-label="Primary">
							{navItems.map(({ to, label, icon: Icon }) => (
								<NavLink
									key={to}
									to={to}
									title={label}
									aria-label={label}
									className={({ isActive }) => `shrink-0 h-8 w-7 sm:w-8 lg:w-auto lg:h-auto lg:px-2.5 px-0 py-1.5 rounded-md no-underline whitespace-nowrap transition-all flex items-center justify-center gap-1.5 text-sm ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}
								>
									<Icon size={15} className="shrink-0" />
									<span className="hidden lg:inline">{label}</span>
								</NavLink>
							))}
						</nav>
					</>
				)}

				{/* Instance controls injected via useHeaderSlot */}
				{navHidden && headerSlot && (
					<div className="min-w-0 flex-1">
						{headerSlot}
					</div>
				)}

				{/* Right: conversation indicator + notifications + avatar — always visible.
				    The pill sits FIRST so the destinations you can always reach (bell, avatar)
				    keep their position; it renders nothing unless a conversation is live
				    somewhere else, so the bar is unchanged the rest of the time (#278). */}
				{user && (
					<span className={`flex items-center shrink-0 ${navHidden ? "gap-1.5" : "gap-2.5"}`}>
						<ConversationPill />
						<NavLink to="/notifications" className="relative no-underline text-muted" title="Notifications">
							<Bell size={navHidden ? 16 : 18} />
							{unreadCount > 0 && (
								<span className="absolute -top-1 -right-1.5 bg-danger text-white text-2xs w-4 h-4 rounded-full flex items-center justify-center font-bold leading-none">
									{unreadCount > 9 ? "9+" : unreadCount}
								</span>
							)}
						</NavLink>
							<NavLink to="/profile" className="flex items-center text-muted no-underline hover:text-ink">
								<img src={user.avatar} alt="" width={navHidden ? 22 : 26} height={navHidden ? 22 : 26} className={`rounded-full border-2 border-line ${navHidden ? "w-[22px] h-[22px]" : "w-[26px] h-[26px]"}`} />
							</NavLink>
					</span>
				)}

				{/* Hamburger — only when default nav is showing */}
				{!navHidden && (
					<Button
						variant="ghost"
						size="icon"
						className="lg:hidden shrink-0"
						onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
						aria-label="Open menu"
					>
						<Menu size={20} />
					</Button>
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
								className={({ isActive }) => `text-sm px-2.5 py-2 rounded-md no-underline whitespace-nowrap transition-all flex items-center gap-2 ${isActive ? "text-ink bg-line font-bold" : "text-muted hover:text-ink hover:bg-line"}`}
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
				<ErrorBoundary resetKey={location.pathname}>
						<Outlet />
					</ErrorBoundary>
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
		<div className="shrink-0 bg-accent-soft border-b border-accent/25 px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
			<BellRing size={18} className="text-accent shrink-0" />
			<div className="text-sm text-ink flex-1 min-w-[8rem]">
				<b>Turn on alerts</b> so your agent can reach you the moment it needs an answer — even when this tab is closed.
			</div>
			<Button variant="primary" size="lg" onClick={onEnable} disabled={busy} className="order-2 sm:order-none shrink-0 whitespace-nowrap">
				{busy ? "Enabling…" : "🔔 Enable alerts"}
			</Button>
			<button type="button" onClick={onDismiss} className="text-muted hover:text-ink shrink-0 order-3 sm:order-none" aria-label="Dismiss"><X size={16} /></button>
		</div>
	);
}
