import type { ReactNode } from "react";
import { CodingTab } from "@proagentstore/coder-web";
import ActivityTab from "../tabs/ActivityTab";
import BoardTab from "../tabs/BoardTab";
import DataTab from "../tabs/DataTab";
import IndexingTab from "../tabs/IndexingTab";
import KnowledgeTab from "../tabs/KnowledgeTab";
import RepoTab from "../tabs/RepoTab";
import SettingsTab from "../tabs/SettingsTab";
import TmuxTab from "../tabs/TmuxTab";
import type { BoardColumn, SettingsField } from "./types";

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

export type SurfaceId = "chat" | "apply" | "board" | "coding" | "repo" | "tmux" | "activity" | "indexing" | "knowledge" | "data" | "settings";

/** What the shell hands a surface so it can render its body. */
export interface SurfaceContext {
	instanceId: string;
	isApply: boolean;
	sessionId?: string;
	/** The agent's declared board columns (server resolves a per-surface default). */
	boardColumns?: BoardColumn[];
	/** The agent's declared subscriber settings (rendered on the Settings tab). */
	settingsSchema?: SettingsField[];
	/** Per-surface options (capabilities.surfaceOptions). `repos:"single"` hides the
	 *  multi-repo affordances for an agent that owns exactly one repo. */
	surfaceOptions?: Record<string, { repos?: string; drive?: boolean; copilot?: boolean }>;
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
	/**
	 * May this surface REPLACE the page header while it is the active tab?
	 *
	 * A surface that takes the full viewport (a live terminal) needs the header for its own
	 * context and controls — which repo, is the engine idle, restart it. That is a real need, but
	 * it used to be spelled `if (tab !== "coding")` in InstanceDetail: a string comparison against
	 * one tab name, so no other surface could ever have it and the next one would have added a
	 * second branch. Declared here instead, and the shell derives the behaviour from the registry.
	 *
	 * The surface pushes its node through `ctx.setChildHeader`; the shell clears it automatically
	 * when a surface that does NOT declare this becomes active.
	 */
	ownsHeader?: boolean;
}

export const SURFACES: SurfaceDef[] = [
	{ id: "chat", label: "Assistant", icon: "💬", show: () => true },
	{
		id: "apply",
		label: "Apply",
		icon: "📮",
		// The job-application agent's single work board (one card per job, Retry, move,
		// attempts drill-down). The old applications-records detail page was retired.
		show: (s) => s.includes("apply"),
		scroll: true,
		render: ({ instanceId, boardColumns }) => <BoardTab instanceId={instanceId} columns={boardColumns} apply />,
	},
	{
		id: "board",
		label: "Board",
		icon: "📋",
		// Generic work board for agents without their own dedicated surface.
		show: (s) => !s.includes("coding") && !s.includes("apply") && !s.includes("repo") && !s.includes("tmux"),
		scroll: true,
		render: ({ instanceId, boardColumns }) => <BoardTab instanceId={instanceId} columns={boardColumns} />,
	},
	{
		id: "repo",
		label: "Repo",
		icon: "🔍",
		// The read-only repo-chat agent's surface: index a GitHub repo, then chat with it.
		show: (s) => s.includes("repo"),
		scroll: true,
		render: ({ instanceId }) => <RepoTab instanceId={instanceId} />,
	},
	{
		id: "coding",
		label: "Coding",
		icon: "💻",
		show: (s) => s.includes("coding"),
		// A full-screen terminal owns the header: repo + engine status + session actions.
		ownsHeader: true,
		render: ({ instanceId, sessionId, setChildHeader, surfaceOptions }) => (
			<CodingTab
				key={instanceId}
				instanceId={instanceId}
				initialSessionId={sessionId}
				onHeaderOverride={setChildHeader}
				// A Repo Coder owns ONE repo by design; showing add-repo and a repo list it can
				// never use is what made a configured agent look like the hardcoded Coder.
				singleRepo={surfaceOptions?.coding?.repos === "single"}
				// One chat per agent. A configurable Repo Coder declares `copilot:false`, so its
				// Coding tab is the terminal only and every conversation happens in the Assistant
				// — which carries the same repo/git/issue read tools from the registry. The
				// legacy hardcoded Coder declares nothing and keeps its Co-pilot.
				copilot={surfaceOptions?.coding?.copilot !== false}
			/>
		),
	},
	{
		id: "tmux",
		label: "Terminal",
		icon: "▣",
		show: (s) => s.includes("tmux"),
		render: ({ instanceId }) => <TmuxTab instanceId={instanceId} />,
	},
	{
		id: "activity",
		label: "Activity",
		icon: "🪵",
		// A live, readable timeline of everything the agent DID — tool calls, record
		// writes, cron/webhook fires, summaries, errors — the process/reasoning log.
		// Distinct from Board (runtime task jobs) and Data (end-result records).
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <ActivityTab instanceId={instanceId} />,
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
		id: "indexing",
		label: "Indexing",
		icon: "🔎",
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <IndexingTab instanceId={instanceId} />,
	},
	{
		id: "data",
		label: "Data",
		icon: "📊",
		// Spreadsheet view over the agent's structured collections (filter + sort).
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <DataTab instanceId={instanceId} />,
	},
	{
		id: "settings",
		label: "Settings",
		icon: "⚙",
		show: () => true,
		scroll: true,
		render: ({ instanceId, isApply, settingsSchema, onUnsubscribe }) => (
			<SettingsTab instanceId={instanceId} isApply={isApply} settingsSchema={settingsSchema} onUnsubscribe={onUnsubscribe} />
		),
	},
];

export const SURFACE_IDS = SURFACES.map((s) => s.id);

/** Does the surface with this id declare that it may replace the page header? */
export function surfaceOwnsHeader(id: string | undefined): boolean {
	return !!SURFACES.find((s) => s.id === id)?.ownsHeader;
}

/** Tabs visible for an instance with the given capability surfaces, in registry order. */
export function visibleSurfaces(surfaces: string[]): SurfaceDef[] {
	return SURFACES.filter((s) => s.show(surfaces));
}
