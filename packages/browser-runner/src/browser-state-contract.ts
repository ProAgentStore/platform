/** Bounded, redacted observations; no page contents, form values, dialog messages or cookies. */
export interface BrowserStateSnapshot {
 nativeActivePageId: string | null;
 mcpSelectedPageId: string | null;
 selection: "aligned" | "different" | "unknown";
 tabCount: number;
 tabsTruncated: boolean;
 tabs: Array<{ pageId: string; index: number; url: string; title?: string; nativeActive: boolean; mcpSelected: boolean }>;
 pendingChooser: { pageId: string; chooserId: string } | null;
 /** A past MCP observation, never a new listener that changes Playwright dialog behavior. */
 dialog: { status: "unknown" | "observed"; type?: "alert" | "confirm" | "prompt" | "beforeunload"; observedAt?: string };
}
export interface BrowserStateObservation {
 subject: { kind: string; id: string };
 epoch: string;
 capturedAt: string;
 current: boolean;
 availability: "available" | "unavailable";
 state?: BrowserStateSnapshot;
}
