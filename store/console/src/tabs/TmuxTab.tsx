import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderTerminal } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { Clipboard, Keyboard, Loader2, Play, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { tmuxBusy } from "../lib/pollBusy";

interface Props {
	instanceId: string;
}

interface TerminalTarget {
	backend: "tmux" | "kitty" | "iterm2";
	id: string;
	name: string;
	windows?: number;
	attached?: boolean;
	activeCommand?: string;
	activeWindow?: string;
	created?: string;
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

function targetKey(t: TerminalTarget): string {
	return `${t.backend}:${t.id}`;
}

function parseTargets(content?: string): TerminalTarget[] {
	if (!content) return [];
	try {
		const parsed = JSON.parse(content) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): TerminalTarget[] => {
			if (!item || typeof item !== "object") return [];
			const row = item as Record<string, unknown>;
			const backend = row.backend === "tmux" || row.backend === "kitty" || row.backend === "iterm2" ? row.backend : null;
			const id = typeof row.id === "string" ? row.id : "";
			if (!backend || !id) return [];
			return [{
				backend,
				id,
				name: typeof row.name === "string" && row.name ? row.name : id,
				windows: typeof row.windows === "number" ? row.windows : undefined,
				attached: typeof row.attached === "boolean" ? row.attached : undefined,
				activeCommand: typeof row.activeCommand === "string" ? row.activeCommand : undefined,
				activeWindow: typeof row.activeWindow === "string" ? row.activeWindow : undefined,
				created: typeof row.created === "string" ? row.created : undefined,
			}];
		});
	} catch {
		return [];
	}
}

function createdLabel(created?: string): string {
	if (!created) return "";
	const n = Number(created);
	if (!Number.isFinite(n)) return "";
	return new Date(n * 1000).toLocaleString();
}

export default function TmuxTab({ instanceId }: Props) {
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
	const [newBackend, setNewBackend] = useState<"tmux" | "kitty" | "iterm2">("tmux");
	const [newWorkDir, setNewWorkDir] = useState("");
	const [newCommand, setNewCommand] = useState("");
	const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set());
	const selectedRef = useRef("");
	selectedRef.current = selected;

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

	const refreshTargets = useCallback(async () => {
		setLoadingList(true);
		setError("");
		try {
			const content = await callTool("terminal_list_targets");
			const list = parseTargets(content);
			setTargets(list);
			setSelected((current) => {
				if (current && list.some((s) => targetKey(s) === current)) return current;
				return list[0] ? targetKey(list[0]) : "";
			});
			if (list.length === 0) setPane("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingList(false);
		}
	}, [callTool]);

	const capture = useCallback(async (session = selectedRef.current) => {
		if (!session) return;
		setLoadingPane(true);
		setError("");
		try {
			const content = await callTool("terminal_capture", { target: session, lines: 500 });
			setPane(content);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingPane(false);
		}
	}, [callTool]);

	useEffect(() => {
		void loadToolPolicy();
		void refreshTargets();
	}, [loadToolPolicy, refreshTargets]);

	useEffect(() => {
		if (selected) void capture(selected);
	}, [selected, capture]);

	const tick = useCallback(() => {
		void refreshTargets();
		if (selectedRef.current) void capture(selectedRef.current);
	}, [refreshTargets, capture]);

	// Two tool calls per tick — a target list AND a 500-line pane capture — each of which is a
	// relay round-trip to the user's own machine (#272). Full rate while a pane is actually
	// running something, or while the last call FAILED: a failure here means the runner could
	// not be reached, and backing off then is how the tab stays showing an error long after the
	// machine came back (#241). A rack of panes all sitting at a prompt is the slow case.
	useTieredPolling(tick, { activeMs: 4000, passiveMs: 20000 }, tmuxBusy(targets, !!error));

	const selectedInfo = useMemo(() => targets.find((s) => targetKey(s) === selected), [targets, selected]);
	const canRunCommand = allowedTools.has("terminal_run_command");
	const canSendKeys = allowedTools.has("terminal_send_keys");
	const canCreateTarget = allowedTools.has("terminal_new_target");
	const canKillTarget = allowedTools.has("terminal_kill_target");
	const canWrite = canRunCommand || canSendKeys || canCreateTarget || canKillTarget;

	const runCommand = async () => {
		if (!selected || !command.trim()) return;
		setStatus("");
		setError("");
		try {
			const content = await callTool("terminal_run_command", { target: selected, command });
			setPane(content);
			setCommand("");
			setStatus(`Ran in ${selected}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const sendKeysToPane = async () => {
		if (!selected || (!sendText && !sendKeys.trim())) return;
		setStatus("");
		setError("");
		try {
			const keys = sendKeys.split(",").map((key) => key.trim()).filter(Boolean);
			const content = await callTool("terminal_send_keys", { target: selected, text: sendText || undefined, keys });
			setPane(content);
			setSendText("");
			setSendKeys("");
			setStatus(`Sent to ${selected}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const createSession = async () => {
		if (!newSession.trim()) return;
		const sessionName = newSession.trim();
		setStatus("");
		setError("");
		try {
			const raw = await callTool("terminal_new_target", { backend: newBackend, name: sessionName, workDir: newWorkDir.trim() || undefined, command: newCommand.trim() || undefined });
			const created = JSON.parse(raw || "{}") as Partial<TerminalTarget> & { target?: Partial<TerminalTarget> };
			const target = created.target ?? created;
			const next = target.backend && target.id ? `${target.backend}:${target.id}` : `${newBackend}:${sessionName}`;
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
		if (!selected || !confirm(`Kill terminal target "${selected}"?`)) return;
		setStatus("");
		setError("");
		try {
			await callTool("terminal_kill_target", { target: selected });
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
		<div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)] bg-paper">
			<aside className="border-b lg:border-b-0 lg:border-r border-line min-h-0 flex flex-col">
				<div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<Terminal size={16} className="text-accent shrink-0" />
						<h2 className="text-sm font-bold truncate">Terminal</h2>
					</div>
						<button type="button" onClick={refreshTargets} title="Refresh targets" aria-label="Refresh targets" className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-50" disabled={loadingList}>
						<RefreshCw size={14} className={loadingList ? "animate-spin" : ""} />
					</button>
				</div>
				<div className="overflow-y-auto min-h-0 chat-scroll p-2 space-y-1">
					{targets.length === 0 && (
						<div className="text-xs text-muted-soft px-2 py-4">No terminal targets found on the connected runner.</div>
					)}
					{targets.map((s) => (
						<button
							key={targetKey(s)}
							type="button"
							onClick={() => setSelected(targetKey(s))}
							className={`w-full text-left px-2 py-2 rounded-lg border transition-colors ${selected === targetKey(s) ? "border-accent bg-accent-soft" : "border-transparent hover:border-line hover:bg-panel"}`}
						>
							<div className="flex items-center justify-between gap-2 min-w-0">
								<span className="font-mono text-sm truncate">{s.name}</span>
								<span className={`w-2 h-2 rounded-full shrink-0 ${s.attached ? "bg-green" : "bg-muted-soft"}`} title={s.attached ? "Attached" : "Detached"} />
							</div>
							<div className="mt-1 text-[0.7rem] text-muted-soft truncate">
								{s.backend} {s.activeCommand ? `- ${s.activeCommand}` : ""} {s.activeWindow ? `- ${s.activeWindow}` : ""} {s.windows ? `- ${s.windows}w` : ""}
							</div>
						</button>
					))}
				</div>
			</aside>

			<section className="min-h-0 flex flex-col">
				<div className="border-b border-line px-3 py-2 flex flex-wrap items-center justify-between gap-2">
					<div className="min-w-0">
						<div className="flex items-center gap-2 min-w-0">
							<span className="font-mono text-sm font-bold truncate">{selected || "No target selected"}</span>
							{selectedInfo?.attached != null && <span className={`text-[0.65rem] px-1.5 py-0.5 rounded-full ${selectedInfo.attached ? "bg-green/15 text-green" : "bg-panel text-muted"}`}>{selectedInfo.attached ? "attached" : "detached"}</span>}
						</div>
						<div className="text-[0.7rem] text-muted-soft truncate">
							{selectedInfo ? `${selectedInfo.backend}${selectedInfo.activeCommand ? ` - ${selectedInfo.activeCommand}` : ""}${selectedInfo.activeWindow ? ` - ${selectedInfo.activeWindow}` : ""}${createdLabel(selectedInfo.created) ? ` - ${createdLabel(selectedInfo.created)}` : ""}` : "Start a terminal target below or open tmux, kitty, or iTerm2 on the connected machine."}
						</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button type="button" onClick={() => capture()} disabled={!selected || loadingPane} title="Capture pane" aria-label="Capture pane" className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
							{loadingPane ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
						</button>
						<button type="button" onClick={copyPane} disabled={!pane} title="Copy pane output" aria-label="Copy pane output" className="p-1.5 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
							<Clipboard size={14} />
						</button>
							<button type="button" onClick={killSession} disabled={!selected || !canKillTarget} title={canKillTarget ? "Kill target" : "Grant terminal kill access in Settings"} aria-label="Kill target" className="p-1.5 rounded-lg border border-line text-muted hover:text-red hover:border-red disabled:opacity-40">
							<Trash2 size={14} />
						</button>
					</div>
				</div>

				{(error || status || !canWrite) && (
					<div className="px-3 py-2 border-b border-line text-xs">
						{error ? <span className="text-red">{error}</span> : status ? <span className="text-green">{status}</span> : <span className="text-muted">Grant terminal write access in Settings to run commands, send keys, create targets, or close targets.</span>}
					</div>
				)}

				<div className="flex-1 min-h-0 bg-[#080808]">
					<pre className="h-full overflow-auto chat-scroll p-3 text-[0.74rem] leading-relaxed font-mono whitespace-pre-wrap break-words">
						<SafeHtmlView as="code" html={renderTerminal(pane || (selected ? "" : "Select a terminal target to capture its output."))} />
					</pre>
				</div>

				<div className="border-t border-line p-2 space-y-2 bg-panel/40">
					<div className="flex gap-2">
							<input
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") runCommand(); }}
								aria-label="Command"
								placeholder="Command"
									disabled={!selected || !canRunCommand}
							className="font-mono"
						/>
							<button type="button" onClick={runCommand} disabled={!selected || !command.trim() || !canRunCommand} title="Run command" aria-label="Run command" className="px-3 rounded-lg bg-accent text-white disabled:opacity-40">
							<Play size={15} />
						</button>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_11rem_auto] gap-2">
								<input value={sendText} onChange={(e) => setSendText(e.target.value)} aria-label="Text to send" placeholder="Text to send" disabled={!selected || !canSendKeys} className="font-mono" />
								<input value={sendKeys} onChange={(e) => setSendKeys(e.target.value)} aria-label="Keys to send" placeholder="Keys, e.g. Enter" disabled={!selected || !canSendKeys} className="font-mono" />
							<button type="button" onClick={sendKeysToPane} disabled={!selected || (!sendText && !sendKeys.trim()) || !canSendKeys} title="Send keys" aria-label="Send keys" className="px-3 py-2 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
							<Keyboard size={15} />
						</button>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-[8rem_11rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
								<select value={newBackend} onChange={(e) => setNewBackend(e.target.value as "tmux" | "kitty" | "iterm2")} aria-label="Terminal backend" disabled={!canCreateTarget}>
							<option value="tmux">tmux</option>
							<option value="kitty">kitty</option>
							<option value="iterm2">iTerm2</option>
						</select>
								<input value={newSession} onChange={(e) => setNewSession(e.target.value)} aria-label="Target name" placeholder="Name" disabled={!canCreateTarget} className="font-mono" />
								<input value={newWorkDir} onChange={(e) => setNewWorkDir(e.target.value)} aria-label="Working directory" placeholder="Working directory" disabled={!canCreateTarget} className="font-mono" />
								<input value={newCommand} onChange={(e) => setNewCommand(e.target.value)} aria-label="Startup command" placeholder="Startup command" disabled={!canCreateTarget} className="font-mono" />
							<button type="button" onClick={createSession} disabled={!newSession.trim() || !canCreateTarget} title="Create target" aria-label="Create target" className="px-3 py-2 rounded-lg border border-line text-muted hover:text-accent hover:border-accent disabled:opacity-40">
							<Plus size={15} />
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}
