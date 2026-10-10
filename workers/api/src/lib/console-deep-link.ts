/**
 * A precise console URL for one instance — or one run, record or section of it (#938).
 *
 * An agent talking to someone about "the Coding tab", "that run" or "the secret it is waiting for"
 * had to guess the console's URL scheme, and a guessed link "works" in the worst way: `instances/:id/*`
 * matches any splat and the `*` catch-all swallows the rest, so a wrong link lands on SOME screen,
 * silently. This builds the link from `console-links.ts` — the one module whose every builder is held
 * against the console's own route table (`console-links.test.ts`) — and refuses what would not land:
 * an unknown section, or a tab this instance does not show.
 *
 * ── Why the section table is mirrored here
 *
 * Which tabs an instance renders is decided in the console (`store/console/src/lib/surfaces.tsx`) from
 * its declared capabilities. A Worker cannot import that React registry, so the rule is restated below
 * and `console-deep-link.test.ts` holds the ids equal to the console's `INSTANCE_TABS`. A tab the
 * instance does not show would render a different tab — exactly the silent landing this tool exists to
 * prevent — so it is refused with the tabs it DOES show.
 *
 * ── What it cannot point at
 *
 * The console is a BrowserRouter: a `#fragment` is ignored (`checkConsoleLink`), so there is no anchor
 * finer than a tab or a record page. A "field" is answered with the tab that holds it.
 */
import { codingSessionLink, instanceFilesUploadLink, instanceLink, instanceRunLink, localBrowserRunLink, secureInputNotificationLink } from "./console-links.js";

/** The console's public origin. `/console/…` paths resolve here (and on console.proagentstore.online without the prefix). */
export const CONSOLE_ORIGIN = "https://proagentstore.online";

/** What decides which tabs an instance shows — its resolved capabilities. */
export interface LinkCaps {
	surfaces: readonly string[];
	/** The runner runtime the agent declares — `local_browser` shows the Research tab (#946). */
	runtime?: string | null;
	/** The declared tool allowlist; absent/null means "the surface default", which shows tool-gated tabs. */
	tools?: readonly string[] | null;
}

const KB_TOOLS = ["search_knowledge", "list_knowledge", "read_knowledge", "add_knowledge", "update_knowledge", "delete_knowledge"];
const FILE_TOOLS = ["upload_file", "list_files", "read_file", "delete_file"];
const COLLECTION_TOOLS = ["create_collection", "list_collections", "insert_record", "query_records", "update_record", "delete_record"];
const canUse = (caps: LinkCaps, names: readonly string[]) => !caps.tools || names.some((n) => caps.tools?.includes(n));
/** Mirrors `showsKnowledgeSubTab(caps, "files")` in the console. */
export const canUploadInstanceFiles = (caps: LinkCaps) => canUse(caps, FILE_TOOLS) || canUse(caps, KB_TOOLS);

/** Every instance tab, with the console's rule for showing it (mirrors `surfaces.tsx` `SURFACES`). */
export const CONSOLE_SECTIONS: ReadonlyArray<{ id: string; label: string; shown: (caps: LinkCaps) => boolean; needs?: string }> = [
	{ id: "chat", label: "Assistant", shown: () => true },
	{ id: "apply", label: "Apply", shown: (c) => c.surfaces.includes("apply"), needs: "the apply surface" },
	{ id: "board", label: "Board", shown: (c) => !c.surfaces.includes("apply") && !c.surfaces.includes("repo"), needs: "an agent without the apply or repo surface" },
	{ id: "repo", label: "Repo", shown: (c) => c.surfaces.includes("repo"), needs: "the repo surface" },
	{ id: "coding", label: "Coding", shown: (c) => c.surfaces.includes("coding"), needs: "the coding surface" },
	{ id: "tmux", label: "Terminal", shown: (c) => c.surfaces.includes("tmux"), needs: "the tmux surface" },
	{ id: "research", label: "Research", shown: (c) => c.runtime === "local_browser", needs: 'the "local_browser" runtime' },
	{ id: "applications", label: "Applications", shown: (c) => c.runtime === "local_artifact" || c.runtime === "local_apply", needs: 'the "local_artifact" or "local_apply" runtime' },
	{ id: "activity", label: "Activity", shown: () => true },
	{ id: "stats", label: "Stats", shown: () => true },
	{ id: "knowledge", label: "Knowledge", shown: () => true },
	{ id: "behaviour", label: "Behaviour", shown: () => true },
	{ id: "feedback", label: "Feedback", shown: () => true },
	{ id: "indexing", label: "Index", shown: (c) => c.surfaces.includes("repo") || canUse(c, KB_TOOLS), needs: "the repo surface or knowledge tools" },
	{ id: "data", label: "Data", shown: (c) => canUse(c, COLLECTION_TOOLS), needs: "collection tools" },
	{ id: "settings", label: "Settings", shown: () => true },
];

/** What the link should open. At most one of these per call — a record page already names its tab. */
export type ConsoleTarget =
	| { kind: "instance" }
	| { kind: "section"; section: string }
	/** Knowledge's Files uploader, only where uploaded data is readable by this instance. */
	| { kind: "filesUpload" }
	/** A loop run: its coding session when it drives one, else the Assistant where a chat-driven run reports. */
	| { kind: "run"; runId: string; sessionId: string | null }
	/** A local browser research run (#946) — its page on the Research tab. */
	| { kind: "local_browser_run"; runId: string }
	/** A runtime task (browser task, approval, takeover) — `RunDetail`. */
	| { kind: "task"; taskId: string }
	| { kind: "secure_input"; requestId: string };

export interface ConsoleLink {
	/** Absolute, for a chat message or a notification. */
	url: string;
	/** The same page as a console path (`/console/…`). */
	path: string;
	/** What the person lands on, in words. */
	lands: string;
}

export interface ConsoleLinkError {
	error: string;
	/** Stable machine-readable explanation when the Files uploader is capability-gated. */
	reason?: "files_upload_unsupported";
}

/** The link, or why there is no honest one. Pure: ownership and lookups are the route's job. */
export function buildConsoleLink(instanceId: string, target: ConsoleTarget, caps: LinkCaps): ConsoleLink | ConsoleLinkError {
	const make = (path: string, lands: string): ConsoleLink => ({ url: `${CONSOLE_ORIGIN}${path}`, path, lands });
	switch (target.kind) {
		case "instance":
			return make(instanceLink(instanceId), "the instance, on its Assistant tab");
		case "section": {
			const spec = CONSOLE_SECTIONS.find((s) => s.id === target.section);
			if (!spec) return { error: `"${target.section}" is not a console section. Sections: ${CONSOLE_SECTIONS.map((s) => s.id).join(", ")}.` };
			if (!spec.shown(caps)) {
				const shown = CONSOLE_SECTIONS.filter((s) => s.shown(caps)).map((s) => s.id);
				return { error: `This instance does not show the ${spec.label} tab (it needs ${spec.needs}), so a link to it would land on another tab. It shows: ${shown.join(", ")}.` };
			}
			return make(spec.id === "chat" ? instanceLink(instanceId) : `${instanceLink(instanceId)}/${spec.id}`, `the ${spec.label} tab`);
		}
		case "filesUpload":
			return canUploadInstanceFiles(caps)
				? make(instanceFilesUploadLink(instanceId), "the Knowledge Files tab, ready to upload a file")
				: {
					error: "This instance cannot accept Files uploads because it does not declare file or knowledge-reading capability.",
					reason: "files_upload_unsupported",
				};
		case "run":
			return target.sessionId
				? make(codingSessionLink(instanceId, target.sessionId), "the coding session this run drives — its Co-pilot and terminal")
				: make(instanceLink(instanceId), "the Assistant tab, where this chat-driven run reports its steps (Settings → Autonomous runs lists it with Stop)");
		case "local_browser_run":
			return make(localBrowserRunLink(instanceId, target.runId), "this research run — its steps, any pause waiting on you, and its findings to save or skip");
		case "task":
			return make(instanceRunLink(instanceId, target.taskId), "this task's page — its status, screenshots and any takeover or input it waits on");
		case "secure_input":
			return make(secureInputNotificationLink(instanceId, target.requestId), "the page where the owner enters this secret value");
	}
}
