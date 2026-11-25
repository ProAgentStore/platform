import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { buttonClass } from "../lib/control-classes";

/**
 * The account Preferences page, split into named groups (#1705).
 *
 * The page is one account's settings and had grown to eleven stacked cards, which on a phone is a
 * screen and a half of scrolling to reach Voice. Nothing about WHAT a setting is changed — every
 * card, every save, every scope sentence stays exactly where its component put it. Only which of
 * them is on screen at once changes, and only below `sm`:
 *
 *  - Phone (< 640px): one group at a time, picked from a wrapping row of links at the top, plus a
 *    "Show all" for anyone who wants the old single page.
 *  - Desktop (>= 640px): every group is still on the page, in order, exactly as before. The same
 *    row is a set of jump links there.
 *
 * Every group stays MOUNTED when it is not the one in view (`hidden sm:block`, not a conditional
 * render), so a half-typed operator manual, a pending engine choice or an unsaved phrase is still
 * there when you come back — switching groups can never discard an edit.
 *
 * The group is in the URL (`?group=voice`), so it is linkable and survives reload. An approval
 * link (`?approval=<id>`) opens Notifications, because that is where the approval gate lives.
 */
export const PREFERENCE_GROUPS = [
	{ id: "connections", label: "Connections" },
	{ id: "notifications", label: "Notifications" },
	{ id: "agents", label: "Coding & agents" },
	{ id: "appearance", label: "Appearance & time" },
	{ id: "voice", label: "Voice & translation" },
] as const;

export type PreferenceGroupId = (typeof PREFERENCE_GROUPS)[number]["id"];
export type PreferenceGroupChoice = PreferenceGroupId | "all";

const DEFAULT_GROUP: PreferenceGroupId = "connections";

/** The group a URL asks for. Unknown values fall back rather than showing an empty page. */
export function resolvePreferenceGroup(params: URLSearchParams): PreferenceGroupChoice {
	const asked = params.get("group");
	if (asked === "all") return "all";
	const known = PREFERENCE_GROUPS.find((g) => g.id === asked);
	if (known) return known.id;
	if (params.get("approval")) return "notifications";
	return DEFAULT_GROUP;
}

export function PreferenceGroupNav({ current, onPick }: { current: PreferenceGroupChoice; onPick: (id: PreferenceGroupChoice) => void }) {
	const [params] = useSearchParams();
	const hrefFor = (id: PreferenceGroupChoice) => {
		const next = new URLSearchParams(params);
		next.set("group", id);
		return `?${next.toString()}`;
	};
	const items: ReadonlyArray<{ id: PreferenceGroupChoice; label: string }> = [...PREFERENCE_GROUPS, { id: "all", label: "Show all" }];
	return (
		<nav aria-label="Preferences categories" className="mb-4" data-testid="preference-groups">
			<ul className="flex flex-wrap gap-2 list-none p-0 m-0">
				{items.map((g) => {
					const active = current === g.id;
					return (
						<li key={g.id} className="min-w-0">
							<Link
								to={hrefFor(g.id)}
								replace
								aria-current={active ? "true" : undefined}
								onClick={() => onPick(g.id)}
								className={buttonClass(active ? "primary" : "secondary", "md", "min-h-11 sm:min-h-6 [overflow-wrap:anywhere] text-center")}
							>
								{g.label}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

/**
 * One group's section. Labelled as a region (not given a heading of its own) so a screen reader can
 * jump to it by name without the page gaining a second "Notifications" heading above the card that
 * already has one.
 */
export function PreferenceGroup({ id, current, children }: { id: PreferenceGroupId; current: PreferenceGroupChoice; children: ReactNode }) {
	const label = PREFERENCE_GROUPS.find((g) => g.id === id)?.label ?? id;
	const shown = current === "all" || current === id;
	return (
		<section id={`preferences-${id}`} aria-label={label} tabIndex={-1} data-testid={`preference-group-${id}`} className={`${shown ? "" : "hidden sm:block "}outline-none`}>
			{children}
		</section>
	);
}

/**
 * After the owner PICKS a group: bring it into view and put focus on it, so a keyboard or screen-reader
 * user lands in the group they chose rather than back on the link they pressed. Not run for the
 * initial URL, which must not steal focus from the page's own first control.
 */
export function useFocusPickedGroup(current: PreferenceGroupChoice) {
	// An object, not the id: picking the group already in view (desktop jump links, or a second tap)
	// changes no URL, and must still scroll and focus — a fresh object is a fresh pick.
	const [picked, setPicked] = useState<{ id: PreferenceGroupChoice } | null>(null);
	const handled = useRef<object | null>(null);
	useEffect(() => {
		// Wait until the URL has caught up with the pick: the section is `display: none` until then,
		// and an element that is not displayed cannot take focus.
		if (!picked || picked.id === "all" || picked.id !== current || handled.current === picked) return;
		handled.current = picked;
		const el = document.getElementById(`preferences-${picked.id}`);
		if (!el) return;
		el.focus();
		if (typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches) el.scrollIntoView({ block: "start" });
	}, [picked, current]);
	return (id: PreferenceGroupChoice) => setPicked({ id });
}
