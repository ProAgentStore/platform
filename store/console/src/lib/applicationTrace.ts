import type { ApplicationTraceEntry } from "./types";
import { replayUrl } from "./runReplay";

const words = (value: string) => value.replace(/[._]/g, " ");

/** Explain recorded facts; admission to a tool is never represented as its completion. */
export function applicationTraceLabel(entry: Pick<ApplicationTraceEntry, "type" | "detail">): string {
	const d = entry.detail;
	const text = (key: string) => typeof d[key] === "string" ? String(d[key]) : "";
	const where = replayUrl(text("url")) || text("domain");
	const target = text("target");
	const reason = (text("reason") || text("pauseReason")).replace(/_/g, " ");
	let label = words(entry.type);
	if (entry.type === "browser.navigated") label = "Opened page";
	else if (entry.type === "browser.blocked") label = `Stopped: ${reason || "browser blocker"}`;
	else if (entry.type === "run.paused") label = `Paused: ${reason || "waiting"}`;
	else if (entry.type === "run.resumed") label = "Resumed application";
	else if (entry.type === "screenshot.captured") label = `Captured frame ${typeof d.shot === "number" ? d.shot : ""} (${words(text("point")) || "page"})`;
	else if (entry.type === "field.filled") label = `Filled field${target ? ` “${target}”` : " (target not recorded)"}`;
	else if (entry.type === "artifact.uploaded") label = `Attached ${words(text("kind")) || "document"}`;
	else if (entry.type === "submit.attempted") label = "Attempted submission — confirmation pending";
	else if (entry.type === "submit.confirmed") label = "Submission confirmed";
	else if (entry.type === "run.ended") label = `Run ended: ${words(text("status")) || "finished"}${reason ? ` — ${reason}` : ""}`;
	else if (entry.type === "policy.decision") {
		const tool = text("tool");
		const decision = text("decision");
		if (d.class === "replay" && decision === "missing") label = `Screenshot missing after ${words(text("point")) || words(tool)}: ${reason || "capture unavailable"}`;
		else if (tool === "agent_sign_in") label = `Automatic sign-in ${words(decision) || "checked"}${reason ? `: ${reason}` : ""}`;
		else if (decision === "followed" && text("reason") === "opened_new_tab") label = "Followed newly opened tab";
		else if (tool) {
			const action = tool === "browser_click" ? "click" : words(tool.replace(/^browser_/, ""));
			label = d.class === "action" && decision === "completed" ? `${action === "click" ? "Clicked" : `Completed ${action}`}` : `${words(decision) || "Checked"} ${action}`;
			if (target) label += ` “${target}”`;
			else if (action === "click") label += " (target not recorded)";
			if (reason && decision !== "completed") label += ` — ${reason}`;
		} else label = `${words(text("class")) || "Policy"}: ${words(decision) || "checked"}${reason ? ` — ${reason}` : ""}`;
	}
	return `${label.charAt(0).toUpperCase()}${label.substring(1)}${where ? ` — ${where}` : ""}`;
}
