import type { ReactNode } from "react";
import { CodingTab } from "@proagentstore/coder-web";
import ActivityTab from "../tabs/ActivityTab";
import BehaviourTab from "../tabs/BehaviourTab";
import BoardTab from "../tabs/BoardTab";
import DataTab from "../tabs/DataTab";
import FeedbackTab from "../tabs/FeedbackTab";
import IndexingTab from "../tabs/IndexingTab";
import KnowledgeTab from "../tabs/KnowledgeTab";
import RepoTab from "../tabs/RepoTab";
import SettingsTab from "../tabs/SettingsTab";
import StatsTab from "../tabs/StatsTab";
import TmuxTab from "../tabs/TmuxTab";
import { deepLinkedBuildsRepo } from "./deepLink";
import type { BoardColumn, RunnerPresence, SettingsField } from "./types";

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

export type SurfaceId =
	| "chat"
	| "apply"
	| "board"
	| "coding"
	| "repo"
	| "tmux"
	| "activity"
	| "stats"
	| "indexing"
	| "knowledge"
	| "behaviour"
	| "feedback"
	| "data"
	| "settings";

/** What the shell hands a surface so it can render its body. */
export interface SurfaceContext {
	instanceId: string;
	isApply: boolean;
	/** True when the agent declares the `coding` surface — used by Settings to point users at the Coding tab. */
	isCoding?: boolean;
	/** True when the agent declares the `repo` surface — used by Settings to point users at the Repo tab. */
	isRepo?: boolean;
	sessionId?: string;
	/** The agent's declared board columns (server resolves a per-surface default). */
	boardColumns?: BoardColumn[];
	/** The agent's declared subscriber settings (rendered on the Settings tab). */
	settingsSchema?: SettingsField[];
	/** Per-surface options (capabilities.surfaceOptions). `repos:"single"` hides the
	 *  multi-repo affordances for an agent that owns exactly one repo. */
	surfaceOptions?: Record<string, { repos?: string; drive?: boolean; copilot?: boolean }>;
	/**
	 * Is this agent's runner reachable, and why not (#378)?
	 *
	 * The shell already polls `/runtime/status` for the header dot, so a surface that needs
	 * connectivity reads it from here rather than discovering it by failing a relay round-trip —
	 * and every runtime surface then makes the SAME statement about it as the dot above it.
	 */
	runner?: RunnerPresence;
	/**
	 * The same declared capabilities `show` decided on. A composite surface has to make the same
	 * judgement about its own parts that the registry made about the tab (#509) — handing it the
	 * caps is what lets it ask the shared predicate instead of inventing a second one.
	 */
	caps: SurfaceCaps;
	setChildHeader: (node: ReactNode | null) => void;
	onUnsubscribe: () => void;
}

export interface SurfaceDef {
	id: SurfaceId;
	label: string;
	icon: string;
	/**
	 * Should this tab appear for an instance with these declared capabilities?
	 *
	 * Takes the whole capability set, not just `surfaces`, because some tabs are about what the
	 * agent can DO rather than which surface it mounts: the vector-store view is meaningless to an
	 * agent with no knowledge tools, and the collections view to one that never writes a record.
	 */
	show: (caps: SurfaceCaps) => boolean;
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

/** What a `show` predicate gets to decide on — everything the agent DECLARED. */
export interface SurfaceCaps {
	surfaces: string[];
	/**
	 * The agent's declared tool allowlist, or undefined when it declares none.
	 *
	 * undefined is the important case: an agent that declares nothing gets the per-surface DEFAULT
	 * tool set server-side (`toolNamesFor`), so the console cannot know what it can do and must not
	 * guess. Every predicate below therefore treats "not declared" as permissive — only an agent
	 * that has said exactly what it needs gets the narrower UI. That keeps every legacy and
	 * undeclared agent's tabs exactly as they were.
	 */
	tools?: string[];
}

/** Does a DECLARED allowlist contain any of these? Undefined (not declared) ⇒ permissive. */
function canUse(caps: SurfaceCaps, names: readonly string[]): boolean {
	if (!caps.tools) return true;
	return names.some((n) => caps.tools?.includes(n));
}

/** Reading or writing the knowledge base — what the vector store is built from. */
const KB_TOOLS = ["search_knowledge", "list_knowledge", "read_knowledge", "add_knowledge", "update_knowledge", "delete_knowledge"] as const;
/** Structured collections — what the Data tab renders. */
const COLLECTION_TOOLS = ["create_collection", "list_collections", "insert_record", "query_records", "update_record", "delete_record"] as const;
/** Instance file storage — what the Knowledge → Files sub-tab uploads into. */
const FILE_TOOLS = ["upload_file", "list_files", "read_file", "delete_file"] as const;

/**
 * The vector store behind RAG — named once so the `indexing` SURFACE and the `index` SUB-TAB
 * inside Knowledge cannot drift apart (#509). They render the same component.
 */
const showsIndexing = (caps: SurfaceCaps): boolean => caps.surfaces.includes("repo") || canUse(caps, KB_TOOLS);

/**
 * Should this Knowledge SUB-tab appear (#509)?
 *
 * The `knowledge` surface itself is deliberately ungated below, because it is a composite:
 * Memory, Tasks, Credentials and Rules & Tips are per-instance and universal, and gating the
 * whole tab would take those away from every coding agent to hide two panels. The sub-tabs are
 * a different question. Documents and Files accept data that only the KB/file tools can read
 * back, so on an agent declaring neither, an upload succeeds, vectorises, and is then invisible
 * to the agent — which answers conversationally and looks like it ignored the document.
 *
 * `index` is the sharp end: it is the SAME `VectorsSection` the `indexing` surface was gated to
 * stop showing on coding agents, still reachable one level in. That predicate is shared, not
 * restated, so the half-applied fix cannot happen a second time.
 */
export function showsKnowledgeSubTab(caps: SurfaceCaps, id: string): boolean {
	if (id === "docs") return canUse(caps, KB_TOOLS);
	// Files has TWO readers, not one. An upload's extracted text is vectorised as
	// `sourceType:"file"` (agent-storage/files.ts), and `search_knowledge` searches that source
	// by default — so an agent with KB reads and no file tools still reaches what was uploaded.
	// Gating on the file tools alone would have hidden Files from repo-chat, which declares
	// exactly the three KB reads.
	if (id === "files") return canUse(caps, FILE_TOOLS) || canUse(caps, KB_TOOLS);
	if (id === "index") return showsIndexing(caps);
	return true;
}

export const SURFACES: SurfaceDef[] = [
	{ id: "chat", label: "Assistant", icon: "💬", show: () => true },
	{
		id: "apply",
		label: "Apply",
		icon: "📮",
		// The job-application agent's single work board (one card per job, Retry, move,
		// attempts drill-down). The old applications-records detail page was retired.
		show: ({ surfaces }) => surfaces.includes("apply"),
		scroll: true,
		render: ({ instanceId, boardColumns }) => <BoardTab instanceId={instanceId} columns={boardColumns} apply />,
	},
	{
		id: "board",
		label: "Board",
		icon: "📋",
		// The agent's work board. Hidden only for a surface that either has its OWN board
		// (`apply` renders the same cards with apply-specific columns) or produces no work at all
		// (`repo` is read-only chat over an indexed codebase).
		//
		// A CODING agent was excluded, and that was wrong once it started writing cards: #206 puts
		// every coding session on the board and #155 puts every delegated goal there, so the owner
		// had work recorded about their own agent that only a SUPERVISOR could see — via
		// subordinate_status, which reads exactly these rows.
		show: ({ surfaces: s }) => !s.includes("apply") && !s.includes("repo"),
		scroll: true,
		render: ({ instanceId, boardColumns }) => <BoardTab instanceId={instanceId} columns={boardColumns} />,
	},
	{
		id: "repo",
		label: "Repo",
		icon: "🔍",
		// The read-only repo-chat agent's surface: index a GitHub repo, then chat with it.
		show: ({ surfaces }) => surfaces.includes("repo"),
		scroll: true,
		render: ({ instanceId }) => <RepoTab instanceId={instanceId} />,
	},
	{
		id: "coding",
		label: "Coding",
		icon: "💻",
		show: ({ surfaces }) => surfaces.includes("coding"),
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
				// Arriving from a deploy notification (#338). Read straight off the location rather
				// than threaded through SurfaceContext: this is a deep link, so the surface is
				// mounting fresh on the navigation that carried it, and no later render changes it.
				initialBuildsRepoId={deepLinkedBuildsRepo(window.location.search) ?? undefined}
			/>
		),
	},
	{
		id: "tmux",
		label: "Terminal",
		icon: "▣",
		show: ({ surfaces }) => surfaces.includes("tmux"),
		render: ({ instanceId, runner }) => <TmuxTab instanceId={instanceId} runner={runner} />,
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
		id: "stats",
		label: "Stats",
		icon: "📈",
		// Universal, like Behaviour: every agent CAN be given a card, and the source vocabulary is
		// closed and owner-scoped, so the tab is meaningful before anything is configured. It is
		// deliberately not gated on "has cards" — the empty state is where a subscriber finds out
		// the tab exists and how to fill it (#310 dropped the platform-default card set).
		//
		// Distinct from Activity, which is the raw per-event timeline: this is the aggregate.
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <StatsTab instanceId={instanceId} />,
	},
	{
		id: "knowledge",
		label: "Knowledge",
		icon: "📚",
		// Deliberately NOT gated on KB tools. It is a composite: Documents/Files need them, but
		// Memory and Rules & Tips are per-instance and universal — every agent has memory, and
		// every subscriber can write rules. Gating the tab would take those away to hide two
		// sub-tabs. Splitting the composite is the real fix and is a separate change.
		show: () => true,
		scroll: true,
		render: ({ instanceId, isApply, caps }) => <KnowledgeTab instanceId={instanceId} isApply={isApply} caps={caps} />,
	},
	{
		id: "behaviour",
		label: "Behaviour",
		icon: "🎭",
		// How the agent COMMUNICATES — distinct from Settings (what it IS: repo, engine, runner)
		// and Knowledge (what it KNOWS). Universal: every agent has a manner, and before this it
		// was configurable nowhere, which is why an agent asked to be less technical stored the
		// preference in Memory. Registered here rather than hardcoded into the page so it obeys the
		// same rules as every other tab.
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <BehaviourTab instanceId={instanceId} />,
	},
	{
		id: "feedback",
		label: "Feedback",
		icon: "🚩",
		// Universal, like Behaviour and Stats, and for a reason specific to this surface: EVERY
		// agent can be complained about, so gating it on `capabilities.surfaces` would hide it
		// exactly where a new agent type most needs it. A tab rather than a sub-tab of Knowledge or
		// Activity because #509 is the freshly-paid-for lesson that a surface one level inside a
		// composite is a surface nobody finds.
		show: () => true,
		scroll: true,
		render: ({ instanceId }) => <FeedbackTab instanceId={instanceId} />,
	},
	{
		id: "indexing",
		label: "Indexing",
		icon: "🔎",
		// The vector store behind RAG. An agent with no knowledge tools has nothing indexed and
		// nothing that searches it, so this rendered an empty panel on every coding agent — the
		// same "shown because nobody asked whether the agent declares it" failure as the second
		// chat. The `repo` surface counts: repo-chat ingests a codebase INTO this store.
		show: showsIndexing,
		scroll: true,
		render: ({ instanceId }) => <IndexingTab instanceId={instanceId} />,
	},
	{
		id: "data",
		label: "Data",
		icon: "📊",
		// Spreadsheet view over the agent's structured collections (filter + sort). Collections are
		// only ever created by an agent's own tools or its pipelines, so one that declares neither
		// can never have a row here — the tab was permanently empty with no way to fill it.
		show: (caps) => canUse(caps, COLLECTION_TOOLS),
		scroll: true,
		render: ({ instanceId }) => <DataTab instanceId={instanceId} />,
	},
	{
		id: "settings",
		label: "Settings",
		icon: "⚙",
		show: () => true,
		scroll: true,
		render: ({ instanceId, isApply, isCoding, isRepo, settingsSchema, onUnsubscribe }) => (
			<SettingsTab instanceId={instanceId} isApply={isApply} isCoding={isCoding} isRepo={isRepo} settingsSchema={settingsSchema} onUnsubscribe={onUnsubscribe} />
		),
	},
];

export const SURFACE_IDS = SURFACES.map((s) => s.id);

/** Does the surface with this id declare that it may replace the page header? */
export function surfaceOwnsHeader(id: string | undefined): boolean {
	return !!SURFACES.find((s) => s.id === id)?.ownsHeader;
}

/** Tabs visible for an instance with the given capability surfaces, in registry order. */
export function visibleSurfaces(caps: SurfaceCaps | string[]): SurfaceDef[] {
	// Accepts a bare surface array so a caller with no capability object (and every existing test)
	// keeps working — it simply means "nothing declared", which is the permissive case.
	const c: SurfaceCaps = Array.isArray(caps) ? { surfaces: caps } : caps;
	return SURFACES.filter((s) => s.show(c));
}
