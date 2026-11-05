/** Closed diagnostics fields: never persist raw MCP arguments, page HTML, or unbounded error output. */
import { captionUrl, type BrowserArtifactSubject } from "./browser-artifacts.js";
import { browserEvidenceText } from "./browser-evidence-text.js";
import { sanitizeBrowserToolDiagnostic, type StoredBrowserToolDiagnostic } from "./browser-tool-diagnostic.js";
export interface BrowserEvidenceTarget { userId: string; instanceId: string; subjectKind: BrowserArtifactSubject; subjectId: string }
export const recordOf = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const bounded = (v: unknown, max: number) => typeof v === "string" && v.length <= max ? v : undefined;
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export interface StoredBrowserCall {
 seq: number; callId: string; subject: { kind: BrowserArtifactSubject; id: string }; tool: string;
 args: Record<string, unknown>; startedAt: string; durationMs: number;
 outcome: "ok" | "tool_error" | "thrown" | "refused"; internal: boolean; browserState?: unknown; errorHead?: string; urlAfter?: string; toolDiagnostic?: StoredBrowserToolDiagnostic;
}
export function sanitizeBrowserCall(raw: unknown, target: BrowserEvidenceTarget): StoredBrowserCall | null {
 const r = recordOf(raw); const subject = recordOf(r?.subject);
 if (!r || subject?.kind !== target.subjectKind || subject.id !== target.subjectId || !integer(r.seq) || !bounded(r.callId, 128) || !bounded(r.tool, 100) || typeof r.startedAt !== "string" || !Number.isFinite(Date.parse(r.startedAt)) || !integer(r.durationMs) || !["ok", "tool_error", "thrown", "refused"].includes(String(r.outcome))) return null;
 const args: Record<string, unknown> = {}; const input = recordOf(r.args) ?? {};
 for (const [key, max] of Object.entries({ element: 200, role: 60, ref: 100, target: 100, key: 40, action: 40 })) { const value = browserEvidenceText(input[key], max); if (value !== undefined) args[key] = value; }
 for (const key of ["textLength", "valuesCount", "pathsCount", "index", "time", "dx", "dy"]) if (typeof input[key] === "number" && Number.isFinite(input[key])) args[key] = input[key];
 for (const key of ["accept", "hasFunction"]) if (typeof input[key] === "boolean") args[key] = input[key];
 const url = captionUrl(input.url).url; if (url) args.url = url;
 const observedState = r.browserState ? sanitizeBrowserState({ subject: r.subject, epoch: "call", capturedAt: r.startedAt, availability: "available", current: false, state: r.browserState }, target)?.state : undefined;
 const urlAfter = captionUrl(r.urlAfter).url; const errorHead = browserEvidenceText(r.errorHead, 200);
 const toolDiagnostic = sanitizeBrowserToolDiagnostic(r.toolDiagnostic);
 return { seq: r.seq as number, callId: r.callId as string, subject: { kind: target.subjectKind, id: target.subjectId }, tool: r.tool as string, args, startedAt: r.startedAt, durationMs: r.durationMs as number, outcome: r.outcome as StoredBrowserCall["outcome"], internal: r.internal === true, ...(observedState ? { browserState: observedState } : {}), ...(errorHead !== undefined ? { errorHead } : {}), ...(urlAfter ? { urlAfter } : {}), ...(toolDiagnostic ? { toolDiagnostic } : {}) };
}
export function sanitizeBrowserState(raw: unknown, target: BrowserEvidenceTarget) {
 const r = recordOf(raw); const subject = recordOf(r?.subject); const s = recordOf(r?.state);
 if (!r || subject?.kind !== target.subjectKind || subject.id !== target.subjectId || !bounded(r.epoch, 128) || typeof r.capturedAt !== "string" || !Number.isFinite(Date.parse(r.capturedAt))) return null;
 if (r.availability === "unavailable") return { subject: { kind: target.subjectKind, id: target.subjectId }, epoch: r.epoch, capturedAt: r.capturedAt, current: false, availability: "unavailable" as const };
 if (!s || r.availability !== "available" || !Array.isArray(s.tabs) || s.tabs.length > 20) return null;
 const tabs = s.tabs.map(recordOf).filter((t): t is Record<string, unknown> => !!t).map(t => ({ pageId: bounded(t.pageId, 128) ?? null, index: integer(t.index) ? t.index : null, url: t.url === "about:blank" ? "about:blank" : captionUrl(t.url).url, ...(browserEvidenceText(t.title, 200) !== undefined ? { title: browserEvidenceText(t.title, 200) } : {}), nativeActive: t.nativeActive === true, mcpSelected: t.mcpSelected === true }));
 const chooser = recordOf(s.pendingChooser); const dialog = recordOf(s.dialog);
 return { subject: { kind: target.subjectKind, id: target.subjectId }, epoch: r.epoch, capturedAt: r.capturedAt, current: r.current === true, availability: "available" as const, state: { nativeActivePageId: bounded(s.nativeActivePageId, 128) ?? null, mcpSelectedPageId: bounded(s.mcpSelectedPageId, 128) ?? null, selection: ["aligned", "different"].includes(String(s.selection)) ? s.selection : "unknown", tabCount: integer(s.tabCount) ? s.tabCount : tabs.length, tabsTruncated: s.tabsTruncated === true, tabs, pendingChooser: chooser && bounded(chooser.pageId, 128) && bounded(chooser.chooserId, 128) ? { pageId: chooser.pageId, chooserId: chooser.chooserId } : null, dialog: dialog?.status === "observed" ? { status: "observed", ...(["alert", "confirm", "prompt", "beforeunload"].includes(String(dialog.type)) ? { type: dialog.type } : {}), ...(typeof dialog.observedAt === "string" && Number.isFinite(Date.parse(dialog.observedAt)) ? { observedAt: dialog.observedAt } : {}) } : { status: "unknown" } } };
}
