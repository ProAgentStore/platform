import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderTerminal } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { Clipboard, Keyboard, List, Loader2, Play, Plus, RefreshCw, SlidersHorizontal, SquareTerminal, Terminal, Trash2 } from "lucide-react";
import { tmuxBusy } from "../lib/pollBusy";
import DeploymentCard from "../components/DeploymentCard";
import {
	captureArgs,
	createArgs,
	createdTargetKey,
	killArgs,
	nextSelection,
	parseTargets,
	resolveTerminalAccess,
	resolveTerminalWrites,
	runArgs,
	sendKeysArgs,
	type TerminalBackend,
	type TerminalTarget,
	targetKey,
} from "../lib/terminalTools";
import { DEFAULT_TMUX_VIEW, TMUX_VIEWS, type TmuxView, tmuxBlockClass, tmuxPaneState } from "../lib/tmuxView";
import type { RunnerPresence } from "../lib/types";

interface Props {
	instanceId: string;
	/**
	 * Is the runner reachable, from the shell's own `/runtime/status` poll (#378)?
	 *
	 * Optional because a surface must render before the first status answer lands, and because the
	 * shell is the only caller — `online: null` (or no prop at all) means "not answered yet", which
	 * `tmuxPaneState` deliberately treats as unknown rather than as offline.
	 */
	runner?: RunnerPresence;
}

interface ToolResult {
	content?: string;
	success?: boolean;
	error?: string;
}

interface ToolPolicyEntry {
	name: string;
	allowed: boolean;
	scope: "read" | "write";
	reason?: string;
}

/** Icon + label for each phone view. Icon-only below `sm` so the switch is not itself the thing eating the viewport. */
const VIEW_CHROME: Record<TmuxView, { label: string; Icon: typeof List }> = {
	targets: { label: "Targets", Icon: List },
	output: { label: "Output", Icon: SquareTerminal },
	controls: { label: "Controls", Icon: SlidersHorizontal },
};

/**
 * The create-target row, with and without the backend picker.
 *
 * Both spelled out in full, never composed — Tailwind v4 generates utilities by scanning source
 * text for whole class names, so a template literal that assembled the column list would emit no
 * rule at all. Same reason `tmuxView.ts` writes out its two `hidden lg:*` variants.
 */
const CREATE_GRID_WITH_BACKEND = "grid grid-cols-1 sm:grid-cols-[8rem_11rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2";
const CREATE_GRID_ONE_BACKEND = "grid grid-cols-1 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2";

/** Notice tone → colour. The DECISION of which tone applies is `tmuxPaneState`'s; this is paint. */
const NOTICE_TONE: Record<"error" | "status" | "hint", string> = {
	error: "text-danger",
	status: "text-success",
	hint: "text-muted",
};

function createdLabel(created?: string): string {
	if (!created) return "";
	const n = Number(created);
	if (!Number.isFinite(n)) return "";
	return new Date(n * 1000).toLocaleString();
}

export default function TmuxTab({ instanceId, runner }: Props) {
	const [targets, setTargets] = useState<TerminalTarget[]>([]);
	const [selected, setSelected] = useState("");
	const [pane, setPane] = useState("");
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [loadingList, setLoadingList] = useState(false);
	const [loadingPane, setLoadingPane] = useState(false);
	const [command, setCommand] = useState("");
	const [sendText, setSendText] = useState("");
	const [sendKeys, setSendKeys] = useState("");
	const [newSession, setNewSession] = useState("");
	const [newBackend, setNewBackend] = useState<TerminalBackend>("tmux");
	const [newWorkDir, setNewWorkDir] = useState("");
	const [newCommand, setNewCommand] = useState("");
	/**
	 * `null` until the policy lands — NOT an empty set (#409). An empty set is a real answer ("this
	 * agent has no terminal tools"), and rendering that answer during the first round trip would put
	 * a red line on screen and then withdraw it, which is the flicker #378 removed.
	 */
	const [allowedTools, setAllowedTools] = useState<Set<string> | null>(null);
	// Which block a phone shows. Inert from `lg` up — see `lib/tmuxView.ts` for why the breakpoint
	// stays in CSS and never becomes JS state.
	const [view, setView] = useState<TmuxView>(DEFAULT_TMUX_VIEW);
	const selectedRef = useRef("");
	selectedRef.current = selected;
	/** Keys visible in the PREVIOUS successful poll — used by `nextSelection` to detect new arrivals. */
	const prevKeysRef = useRef<ReadonlySet<string>>(new Set());
	/**
	 * Set when the user explicitly clicks a target in the list; cleared by an auto-select so a
	 * subsequent agent-created session can still be followed (#487).
	 */
	const userPinnedRef = useRef(false);

	const callTool = useCallback(async (name: string, body: Record<string, unknown> = {}) => {
		const result = await api<ToolResult>(`/v1/instances/${instanceId}/tools/${encodeURIComponent(name)}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (result.success === false) throw new Error(result.content || result.error || `${name} failed`);
		return result.content ?? "";
	}, [instanceId]);

	const loadToolPolicy = useCallback(async () => {
		try {
			const data = await api<{ tools?: ToolPolicyEntry[] }>(`/v1/instances/${instanceId}/tools?allowed=true`);
			setAllowedTools(new Set((data.tools || []).map((t) => t.name)));
		} catch {
			setAllowedTools(new Set());
		}
	}, [instanceId]);

	/**
	 * WHICH tools this tab may call, and therefore which family's argument shapes it builds (#409).
	 *
	 * This is the fix's load-bearing line. `1f3ca00` gated the four WRITE controls on this same
	 * policy and left the two reads ungated, because at the time every agent on the `tmux` surface
	 * declared `terminal_*` and the reads were guaranteed present. #403 removed that guarantee, so
	 * the reads now consult it too — and the tab calls the family the agent actually has rather than
	 * a name it hopes for.
	 */
	const access = useMemo(() => resolveTerminalAccess(allowedTools), [allowedTools]);
	const family = access.state === "ready" ? access.family : null;
	const canCapture = access.state === "ready" && access.canCapture;

	// The two POLLED calls write the error slot only when they SETTLE — never on attempt (#378).
	//
	// Clearing it first unmounted the conditionally-rendered notice row and remounted it when the
	// call failed 200ms later; at the 4s tier `tmuxBusy` pins it to while failing, that is a
	// message that blinks forever and can never be read. Writing on completion means it holds
	// the outcome of the LAST COMPLETED attempt, whichever of the two calls that was — so a list
	// that succeeds cannot wipe the reason a capture failed before anyone has seen it either.
	//
	// Both now return EARLY when the agent has not declared the tool, and — the #378 half that
	// matters here — they return without touching the error slot. A refusal we can predict is not
	// an outcome to report in the transport channel; `tmuxPaneState` states it once, from `access`,
	// and it therefore stands across every poll instead of being rewritten by each one.
	const refreshTargets = useCallback(async () => {
		if (!family) return;
		setLoadingList(true);
		try {
			const content = await callTool(family.list);
			const list = parseTargets(family, content);
			setTargets(list);
			setSelected((current) => {
				const next = nextSelection(current, prevKeysRef.current, list, userPinnedRef.current);
				// An auto-select (different from what the user had) clears the pin so a later
				// agent-created session can still be followed (#487).
				if (next !== current) userPinnedRef.current = false;
				prevKeysRef.current = new Set(list.map(targetKey));
				return next;
			});
			if (list.length === 0) setPane("");
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingList(false);
		}
	}, [callTool, family]);

	const capture = useCallback(async (session = selectedRef.current) => {
		if (!session || !family || !canCapture) return;
		setLoadingPane(true);
		try {
			const content = await callTool(family.capture, captureArgs(family, session, 500));
			setPane(content);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingPane(false);
		}
	}, [callTool, family, canCapture]);

	// Two effects, not one. Folded together, the policy would be re-fetched the moment it resolved
	// the family that `refreshTargets` closes over — a second identical round trip on every mount.
	useEffect(() => {
		void loadToolPolicy();
	}, [loadToolPolicy]);

	// Fires when `family` first resolves, which is what makes the first list wait for the policy
	// rather than race it.
	useEffect(() => {
		void refreshTargets();
	}, [refreshTargets]);

	useEffect(() => {
		if (selected) void capture(selected);
	}, [selected, capture]);

	const tick = useCallback(() => {
		void refreshTargets();
		if (selectedRef.current) void capture(selectedRef.current);
	}, [refreshTargets, capture]);

	// Two tool calls per tick — a target list AND a 500-line pane capture — each of which is a
	// relay round-trip to the user's own machine (#272). Full rate while a pane is actually
	// running something, or while we believe the runner is unreachable: that is the state a change
	// is imminent from, and backing off then is how the tab stays showing an error long after the
	// machine came back (#241). A rack of panes all sitting at a prompt is the slow case.
	//
	// Offline is now supplied by the runner-presence signal as well as by a failed call, so the
	// fast tier starts at the FIRST paint of an offline tab rather than only after a round-trip has
	// failed. `pollBusy`'s rule is unchanged — it is being handed a better fact.
	useTieredPolling(tick, { activeMs: 4000, passiveMs: 20000 }, tmuxBusy(targets, !!error || runner?.online === false));

	const selectedInfo = useMemo(() => targets.find((s) => targetKey(s) === selected), [targets, selected]);
	// Still one verdict per WRITE tool, which is `1f3ca00`'s shipped promise — resolved against the
	// family this agent actually has rather than against six hardcoded names.
	const writes = useMemo(() => resolveTerminalWrites(family, allowedTools), [family, allowedTools]);
	const noun = family?.noun ?? "target";
	/** The backends the create form may offer; a backend-exclusive family has nothing to choose. */
	const backends = family?.backends ?? [];
	const createBackend: TerminalBackend = backends.includes(newBackend) ? newBackend : (backends[0] ?? "tmux");
	// Every sentence this tab prints about connectivity — and, since #409, about what this agent can
	// reach at all — is decided in `lib/tmuxView.ts`. Rendering only.
	const paneState = tmuxPaneState({
		presence: runner ?? { online: null },
		access,
		error,
		status,
		canWrite: writes.any,
		selected,
		targetCount: targets.length,
	});

	const runCommand = async () => {
		if (!selected || !command.trim() || !family) return;
		setStatus("");
		setError("");
		try {
			const content = await callTool(family.run, runArgs(family, selected, command));
			setPane(content);
			setCommand("");
			setStatus(`Ran in ${selected}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const sendKeysToPane = async () => {
		if (!selected || (!sendText && !sendKeys.trim()) || !family) return;
		setStatus("");
		setError("");
		try {
			const keys = sendKeys.split(",").map((key) => key.trim()).filter(Boolean);
			const content = await callTool(family.sendKeys, sendKeysArgs(family, selected, sendText, keys));
			setPane(content);
			setSendText("");
			setSendKeys("");
			setStatus(`Sent to ${selected}`);
			// Send-keys lives in the Controls view on a phone, and its whole point is what the pane
			// does next. Leaving the user on a form while the answer lands in a hidden block is the
			// same class of bug as the one this tab had.
			setView("output");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const createSession = async () => {
		if (!newSession.trim() || !family) return;
		const sessionName = newSession.trim();
		setStatus("");
		setError("");
		try {
			const raw = await callTool(family.create, createArgs(family, { backend: createBackend, name: sessionName, workDir: newWorkDir.trim(), command: newCommand.trim() }));
			const next = createdTargetKey(family, raw, createBackend, sessionName);
			setStatus(`Created ${sessionName}`);
			setNewSession("");
			setNewWorkDir("");
			setNewCommand("");
			await refreshTargets();
			setSelected(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const killSession = async () => {
		if (!selected || !family || !confirm(`Kill ${family.noun} "${selected}"?`)) return;
		setStatus("");
		setError("");
		try {
			await callTool(family.kill, killArgs(family, selected));
			setPane("");
			setSelected("");
			setStatus(`Killed ${selected}`);
			await refreshTargets();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const copyPane = async () => {
		if (!pane) return;
		await navigator.clipboard.writeText(pane).catch(() => {});
		setStatus("Copied pane output");
	};

	return (
		<>
		<div className="flex-1 min-h-0 flex flex-col bg-paper">
			{/*
			 * Phone view switch (#370). Below `lg` the grid collapses to one column and all eight
			 * blocks stack; the `<pre>` is the only `flex-1` element among them, so it measured 24px
			 * — its own padding, zero lines — at both 320px and 390px. Switching views instead of
			 * stacking them is what CodingTab already does on the same phone, so this copies that
			 * control's markup, its `aria-pressed` treatment and its icon-only-below-`sm` sizing
			 * rather than inventing a fourth segmented control (#366).
			 */}
			<div className="lg:hidden shrink-0 border-b border-line px-2 py-1.5 flex items-center gap-2">
				<div className="flex border border-line rounded-lg overflow-hidden shrink-0">
					{TMUX_VIEWS.map((id) => {
						const { label, Icon } = VIEW_CHROME[id];
						return (
							<button
								key={id}
								type="button"
								onClick={() => setView(id)}
								title={label}
								aria-label={label}
								aria-pressed={view === id}
								className={`flex items-center justify-center gap-1 w-8 sm:w-auto sm:px-2 py-1 text-xs font-bold ${view === id ? "bg-accent-soft text-accent" : "text-muted"}`}
							>
								<Icon size={14} />
								<span className="hidden sm:inline">{label}</span>
							</button>
						);
					})}
				</div>
				{/* Which target the Controls view is typing into, since its header belongs to Output. */}
				<span className="font-mono text-2xs text-muted-soft truncate min-w-0">{selected || `no ${noun} selected`}</span>
			</div>

			<div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
				<aside className={`${tmuxBlockClass(view, ["targets"])} border-b lg:border-b-0 lg:border-r border-line min-h-0 flex-col`}>
					<div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2">
						<div className="flex items-center gap-2 min-w-0">
							<Terminal size={16} className="text-accent shrink-0" />
							<h2 className="text-sm font-bold truncate">Terminal</h2>
						</div>
							<button type="button" onClick={refreshTargets} title={`Refresh ${noun}s`} aria-label={`Refresh ${noun}s`} className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-50" disabled={loadingList || !family}>
							<RefreshCw size={14} className={loadingList ? "animate-spin" : ""} />
						</button>
					</div>
					<div className="overflow-y-auto min-h-0 chat-scroll p-2 space-y-1">
						{targets.length === 0 && (
							<div className="text-xs text-muted-soft px-2 py-4">{paneState.emptyTargets}</div>
						)}
						{targets.map((s) => (
							<button
								key={targetKey(s)}
								type="button"
								// Picking a target on a phone is asking for its output, so go there.
								// Setting userPinnedRef before the state update means the next poll
								// will not auto-jump away from this explicit choice (#487).
								onClick={() => { userPinnedRef.current = true; setSelected(targetKey(s)); setView("output"); }}
								className={`w-full text-left px-2 py-2 rounded-lg border transition-colors ${selected === targetKey(s) ? "border-accent bg-accent-soft" : "border-transparent hover:border-line hover:bg-panel"}`}
							>
								<div className="flex items-center justify-between gap-2 min-w-0">
									<span className="font-mono text-sm truncate">{s.name}</span>
									<span className={`w-2 h-2 rounded-full shrink-0 ${s.attached ? "bg-success" : "bg-muted-soft"}`} title={s.attached ? "Attached" : "Detached"} />
								</div>
								<div className="mt-1 text-2xs text-muted-soft truncate">
									{s.backend} {s.activeCommand ? `- ${s.activeCommand}` : ""} {s.activeWindow ? `- ${s.activeWindow}` : ""} {s.windows ? `- ${s.windows}w` : ""}
								</div>
							</button>
						))}
					</div>
				</aside>

				<section className={`${tmuxBlockClass(view, ["output", "controls"])} min-h-0 flex-col`}>
					<div className={`${tmuxBlockClass(view, ["output"])} border-b border-line px-3 py-2 flex-wrap items-center justify-between gap-2`}>
						<div className="min-w-0">
							<div className="flex items-center gap-2 min-w-0">
								<span className="font-mono text-sm font-bold truncate">{selected || `No ${noun} selected`}</span>
								{selectedInfo?.attached != null && <span className={`text-2xs px-1.5 py-0.5 rounded-full ${selectedInfo.attached ? "bg-success-soft text-success" : "bg-panel text-muted"}`}>{selectedInfo.attached ? "attached" : "detached"}</span>}
							</div>
							<div className="text-2xs text-muted-soft truncate">
								{selectedInfo ? `${selectedInfo.backend}${selectedInfo.activeCommand ? ` - ${selectedInfo.activeCommand}` : ""}${selectedInfo.activeWindow ? ` - ${selectedInfo.activeWindow}` : ""}${createdLabel(selectedInfo.created) ? ` - ${createdLabel(selectedInfo.created)}` : ""}` : paneState.hint}
							</div>
						</div>
						<div className="flex items-center gap-1.5">
							<button type="button" onClick={() => capture()} disabled={!selected || loadingPane || !canCapture} title={canCapture ? "Capture pane" : `Not available: this agent has no ${family?.capture ?? "capture"} tool`} aria-label="Capture pane" className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
								{loadingPane ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
							</button>
							<button type="button" onClick={copyPane} disabled={!pane} title="Copy pane output" aria-label="Copy pane output" className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
								<Clipboard size={14} />
							</button>
								<button type="button" onClick={killSession} disabled={!selected || !writes.kill} title={writes.kill ? `Kill ${noun}` : `Grant ${family?.connector ?? "terminal"} kill access in Settings`} aria-label={`Kill ${noun}`} className="p-1.5 rounded-lg border border-line text-muted hover:text-danger hover:border-danger disabled:opacity-40">
								<Trash2 size={14} />
							</button>
						</div>
					</div>

					{/* Owned by BOTH views: it is the only feedback channel for the actions in Controls.
					    While the runner is unreachable this row is derived from PRESENCE, not from the
					    error slot a poll writes — so it stands for as long as the condition does instead
					    of unmounting and remounting every 4 seconds. */}
					{paneState.notice && (
						<div className={`${tmuxBlockClass(view, ["output", "controls"], "block")} px-3 py-2 border-b border-line text-xs`}>
							<span className={NOTICE_TONE[paneState.notice.tone]}>{paneState.notice.text}</span>
							{paneState.notice.remedy && (
								<span className="text-muted"> Run <code className="px-1 py-0.5 rounded bg-paper border border-line font-mono">{paneState.notice.remedy}</code> on {paneState.notice.remedyOn}.</span>
							)}
						</div>
					)}

					{/* `bg-paper` rather than the `#080808` literal it was: the values differ by 2/255 and
					    the design system's rule is not to hardcode a colour a token already names. */}
					<div className={`${tmuxBlockClass(view, ["output"], "block")} flex-1 min-h-0 bg-paper`}>
						{/* `whitespace-pre-wrap break-words` keeps a wide pane wrapping inside its own column
						    instead of panning the page — the platform rule for wide monospace content. */}
						<pre className="h-full overflow-auto chat-scroll p-3 text-xs leading-relaxed font-mono whitespace-pre-wrap break-words">
							<SafeHtmlView as="code" html={renderTerminal(pane || paneState.emptyPane)} />
						</pre>
					</div>

					{/* The command row stays with the pane: it is one row that never stacks, and Run's only
					    observable effect is what the pane shows next. */}
					<div className={`${tmuxBlockClass(view, ["output"], "block")} border-t border-line p-2 bg-panel/40`}>
						<div className="flex gap-2">
								<input
									value={command}
									onChange={(e) => setCommand(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter") runCommand(); }}
									aria-label="Command"
									placeholder="Command"
										disabled={!selected || !writes.run}
								className="font-mono"
							/>
								<button type="button" onClick={runCommand} disabled={!selected || !command.trim() || !writes.run} title="Run command" aria-label="Run command" className="px-3 rounded-lg bg-accent text-white disabled:opacity-40">
								<Play size={15} />
							</button>
						</div>
					</div>

					{/* The two rows that caused it: `grid-cols-1` below `sm` turns them into five
					    full-width, fixed-height inputs. They get their own view instead of the pane's. */}
					<div className={`${tmuxBlockClass(view, ["controls"], "block")} border-t border-line lg:border-t-0 p-2 lg:pt-0 space-y-2 bg-panel/40`}>
						<div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_11rem_auto] gap-2">
									<input value={sendText} onChange={(e) => setSendText(e.target.value)} aria-label="Text to send" placeholder="Text to send" disabled={!selected || !writes.sendKeys} className="font-mono" />
									<input value={sendKeys} onChange={(e) => setSendKeys(e.target.value)} aria-label="Keys to send" placeholder="Keys, e.g. Enter" disabled={!selected || !writes.sendKeys} className="font-mono" />
								<button type="button" onClick={sendKeysToPane} disabled={!selected || (!sendText && !sendKeys.trim()) || !writes.sendKeys} title="Send keys" aria-label="Send keys" className="px-3 py-2 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
								<Keyboard size={15} />
							</button>
						</div>
						<div className={backends.length > 1 ? CREATE_GRID_WITH_BACKEND : CREATE_GRID_ONE_BACKEND}>
							{/* Only when there is a choice. A backend-exclusive family has exactly one, so the
							    picker was three options of which two produced a call the agent cannot make. */}
							{backends.length > 1 && (
										<select value={createBackend} onChange={(e) => setNewBackend(e.target.value as TerminalBackend)} aria-label="Terminal backend" disabled={!writes.create}>
									{backends.map((b) => <option key={b} value={b}>{b === "iterm2" ? "iTerm2" : b}</option>)}
								</select>
							)}
									<input value={newSession} onChange={(e) => setNewSession(e.target.value)} aria-label={`${noun[0].toUpperCase()}${noun.slice(1)} name`} placeholder="Name" disabled={!writes.create} className="font-mono" />
									<input value={newWorkDir} onChange={(e) => setNewWorkDir(e.target.value)} aria-label="Working directory" placeholder="Working directory" disabled={!writes.create} className="font-mono" />
									<input value={newCommand} onChange={(e) => setNewCommand(e.target.value)} aria-label="Startup command" placeholder="Startup command" disabled={!writes.create} className="font-mono" />
								<button type="button" onClick={createSession} disabled={!newSession.trim() || !writes.create} title={`Create ${noun}`} aria-label={`Create ${noun}`} className="px-3 py-2 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
								<Plus size={15} />
							</button>
						</div>
					</div>
				</section>
			</div>
		</div>
		<div className="shrink-0 border-t border-line">
			<DeploymentCard instanceId={instanceId} />
		</div>
		</>
	);
}
