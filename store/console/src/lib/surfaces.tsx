import type { ReactNode } from "react";
import { CodingTab } from "@proagentstore/coder-web";
import ApplyTab from "../tabs/ApplyTab";
import BoardTab from "../tabs/BoardTab";
import KnowledgeTab from "../tabs/KnowledgeTab";
import SettingsTab from "../tabs/SettingsTab";

// ─────────────────────────────────────────────────────────────────────────────
// Surface registry — the console "shell" loads agent UIs from here.
//
// Today every agent's UI is a tab hardcoded into InstanceDetail. This registry
// is the seam that flips that: a surface declares its own tab + body, and the
// shell renders whichever surfaces an instance's capabilities expose. Adding an
// agent UI = adding ONE entry here, not editing the page in four places.
//
// P1 (now): first-party surfaces, statically imported (no behavior change).
// P3 (later): third-party surfaces loaded dynamically from published bundles.
// See ../../../PLAN-agent-os.md.
// ─────────────────────────────────────────────────────────────────────────────

export type SurfaceId = "chat" | "apply" | "board" | "coding" | "knowledge" | "settings";

/** What the shell hands a surface so it can render its body. */
export interface SurfaceContext {
	instanceId: string;
	isApply: boolean;
	sessionId?: string;
	setChildHeader: (node: ReactNode | null) => void;
	onUnsubscribe: () => void;
}

export interface SurfaceDef {
	id: SurfaceId;
	label: string;
	icon: string;
	/** Show this surface for an instance whose capability surfaces are `surfaces`. */
	show: (surfaces: string[]) => boolean;
	/**
	 * Renders the surface body. Omitted for `chat`, which the shell renders inline
	 * because it owns the page-level chat/voice/loop state.
	 */
	render?: (ctx: SurfaceContext) => ReactNode;
	/** Wrap the body in the standard scroll padding (board/knowledge/settings) vs. render raw (coding). */
	scroll?: boolean;
}

export const SURFACES: SurfaceDef[] = [
	{ id: "chat", label: "Chat", icon: "💬", show: () => true },
	{
		id: "apply",
		label: "Apply",
		icon: "📮",
		// The job-application agent's dedicated surface (applications + the shared board).
		show: (s) => s.includes("apply"),
		scroll: true,
		render: ({ instanceId }) => <ApplyTab instanceId={instanceId} />,
	},
	{
		id: "board",
		label: "Board",
		icon: "📋",
		// Generic runtime board for non-coding, non-apply agents (those have their own surface).
		show: (s) => !s.includes("coding") && !s.includes("apply"),
		scroll: true,
		render: ({ instanceId }) => <BoardTab instanceId={instanceId} />,
	},
	{
		id: "coding",
		label: "Coding",
		icon: "💻",
		show: (s) => s.includes("coding"),
		render: ({ instanceId, sessionId, setChildHeader }) => (
			<CodingTab key={instanceId} instanceId={instanceId} initialSessionId={sessionId} onHeaderOverride={setChildHeader} />
		),
	},
	{
		id: "knowledge",
		label: "Knowledge",
		icon: "📚",
		show: () => true,
		scroll: true,
		render: ({ instanceId, isApply }) => <KnowledgeTab instanceId={instanceId} isApply={isApply} />,
	},
	{
		id: "settings",
		label: "Settings",
		icon: "⚙",
		show: () => true,
		scroll: true,
		render: ({ instanceId, isApply, onUnsubscribe }) => (
			<SettingsTab instanceId={instanceId} isApply={isApply} onUnsubscribe={onUnsubscribe} />
		),
	},
];

export const SURFACE_IDS = SURFACES.map((s) => s.id);

/** Tabs visible for an instance with the given capability surfaces, in registry order. */
export function visibleSurfaces(surfaces: string[]): SurfaceDef[] {
	return SURFACES.filter((s) => s.show(surfaces));
}
