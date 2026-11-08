import { describe, expect, it } from "vitest";
import { activityViewFromSearch, HISTORY_PANELS, historyIsEmpty, needingFirst, orderPanels, orderVerifications, runNeedsOwner, showsHistoryPanel, verificationHost, verificationTakeover, type PanelNeed } from "./activityView";
import type { BrowserTakeover } from "./browserTakeovers";
import type { LeadVerification } from "./gmailScout";

const q = (s: string) => new URLSearchParams(s);
const need = (...ids: PanelNeed["id"][]): PanelNeed[] => HISTORY_PANELS.map((id) => ({ id, needsOwner: ids.includes(id) }));

describe("activityViewFromSearch", () => {
	it("plain /activity asks for nothing", () => {
		expect(activityViewFromSearch(q(""))).toEqual({ focusHistory: false, panel: null, takeover: null });
	});
	it("?view=history focuses History; &panel= one panel", () => {
		expect(activityViewFromSearch(q("view=history"))).toEqual({ focusHistory: true, panel: null, takeover: null });
		expect(activityViewFromSearch(q("view=history&panel=loop-runs")).panel).toBe("loop-runs");
		for (const id of HISTORY_PANELS) expect(activityViewFromSearch(q(`view=history&panel=${id}`)).panel).toBe(id);
	});
	it("an unknown panel or view is ignored", () => {
		expect(activityViewFromSearch(q("view=history&panel=nope")).panel).toBeNull();
		expect(activityViewFromSearch(q("view=other"))).toEqual({ focusHistory: false, panel: null, takeover: null });
	});
	it("takeover=<id> focuses the takeovers panel on that row", () => {
		expect(activityViewFromSearch(q("view=history&takeover=t1"))).toEqual({ focusHistory: true, panel: "takeovers", takeover: "t1" });
		expect(activityViewFromSearch(q("takeover=t1&panel=loop-runs")).panel).toBe("takeovers");
		expect(activityViewFromSearch(q("takeover=")).takeover).toBeNull();
	});
});

describe("panel order", () => {
	it("is loop-runs, takeovers, verifications, browser-launch, secure-inputs, deliveries, finder when nothing needs the owner", () => {
		expect(orderPanels(need())).toEqual(["loop-runs", "takeovers", "verifications", "browser-launch", "secure-inputs", "deliveries", "finder"]);
		expect(orderPanels(need().reverse())).toEqual(["loop-runs", "takeovers", "verifications", "browser-launch", "secure-inputs", "deliveries", "finder"]);
	});
	it("a panel holding something for the owner moves ahead, each group keeping its relative order", () => {
		expect(orderPanels(need("deliveries", "takeovers"))).toEqual(["takeovers", "deliveries", "loop-runs", "verifications", "browser-launch", "secure-inputs", "finder"]);
		expect(orderPanels(need("secure-inputs"))[0]).toBe("secure-inputs");
	});
	it("orders only the panels given", () => {
		expect(orderPanels([{ id: "deliveries", needsOwner: false }, { id: "loop-runs", needsOwner: false }])).toEqual(["loop-runs", "deliveries"]);
	});
});

describe("row order within a panel", () => {
	const rows = [{ id: "a", live: false }, { id: "b", live: true }, { id: "c", live: false }, { id: "d", live: true }];
	it("needing-owner rows first, then today's order", () => {
		expect(needingFirst(rows, (r) => r.live).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
	});
	it("changes nothing when no row needs the owner, and does not mutate", () => {
		expect(needingFirst(rows, () => false)).toEqual(rows);
		expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("which panels an agent gets", () => {
	const coding = { runtime: "coding", surfaces: ["coding"] };
	const scout = { runtime: "local_browser", surfaces: ["chat"] };
	it("a coding agent has no browser panels", () => {
		expect(showsHistoryPanel(coding, "takeovers")).toBe(false);
		expect(showsHistoryPanel(coding, "browser-launch")).toBe(false);
		for (const id of ["loop-runs", "secure-inputs", "deliveries"] as const) expect(showsHistoryPanel(coding, id)).toBe(true);
	});
	it("a local browser agent has both", () => {
		expect(showsHistoryPanel(scout, "takeovers")).toBe(true);
		expect(showsHistoryPanel(scout, "browser-launch")).toBe(true);
	});
	it("takeovers are local_browser only; the launch receipt follows any browser runtime", () => {
		expect(showsHistoryPanel({ runtime: "browser", surfaces: [] }, "takeovers")).toBe(false);
		expect(showsHistoryPanel({ runtime: "browser", surfaces: [] }, "browser-launch")).toBe(true);
	});
});

describe("historyIsEmpty", () => {
	const ready = { status: "ready", rows: 0, needsOwner: false } as const;
	it("only once every panel answered with nothing", () => {
		expect(historyIsEmpty([ready, ready])).toBe(true);
		expect(historyIsEmpty([ready, { ...ready, status: "loading" }])).toBe(false);
		expect(historyIsEmpty([ready, { ...ready, rows: 1 }])).toBe(false);
		expect(historyIsEmpty([ready, { ...ready, status: "failed" }])).toBe(false);
	});
});

describe("runNeedsOwner", () => {
	it("is a run that stopped for a human, and nothing else", () => {
		expect(runNeedsOwner({ status: "needs_human" })).toBe(true);
		for (const status of ["running", "completed", "failed", "cancelled"]) expect(runNeedsOwner({ status }), status).toBe(false);
	});
});

describe("the finder panel is the server's verdict, never the runtime or a slug (#1616)", () => {
	it("shows only when originalFinder is true", () => {
		expect(showsHistoryPanel({ runtime: "local_browser", originalFinder: true }, "finder")).toBe(true);
		expect(showsHistoryPanel({ runtime: "local_browser" }, "finder")).toBe(false);
		expect(showsHistoryPanel({ runtime: "local_browser", originalFinder: false }, "finder")).toBe(false);
	});
});

describe("the verifications panel (#1604)", () => {
	it("is for a local_browser agent that is not a Gmail Scout, by the server's verdict", () => {
		expect(showsHistoryPanel({ runtime: "local_browser", surfaces: [] }, "verifications")).toBe(true);
		expect(showsHistoryPanel({ runtime: "local_browser", sourceMode: null, surfaces: [] }, "verifications")).toBe(true);
		expect(showsHistoryPanel({ runtime: "local_browser", sourceMode: "gmail", surfaces: [] }, "verifications")).toBe(false);
		expect(showsHistoryPanel({ runtime: "coding", surfaces: ["coding"] }, "verifications")).toBe(false);
		expect(showsHistoryPanel({ runtime: "browser", surfaces: [] }, "verifications")).toBe(false);
	});

	const lead = (leadId: string, over: Partial<LeadVerification> = {}): LeadVerification => ({ leadId, canonicalUrl: `https://WWW.Seek.com.au/job/${leadId}`, expectedTitle: null, expectedCompany: null, state: "awaiting", attempts: 0, nextAttemptAt: "", lastOutcome: null, lastDetail: null, ...over });
	const tk = (id: string, over: Partial<BrowserTakeover> = {}): BrowserTakeover => ({ id, subjectKind: "manual", subjectId: "site-consent:www.seek.com.au", state: "requested", reason: "consent_required", mobileAllowed: false, endReason: null, expiresAt: "", createdAt: "", activatedAt: null, endedAt: null, ...over });

	it("keys a lead by the lower-cased host of its canonicalUrl", () => {
		expect(verificationHost(lead("a"))).toBe("www.seek.com.au");
		expect(verificationHost(lead("a", { canonicalUrl: "not a url" }))).toBeNull();
	});
	it("a lead needs the owner when it is awaiting and a live manual takeover is for its host", () => {
		expect(verificationTakeover(lead("a"), [tk("t1")])?.id).toBe("t1");
		expect(verificationTakeover(lead("a"), [tk("t1", { state: "active" })])?.id).toBe("t1");
	});
	it("not for another host, a closed takeover, a non-manual one, or a lead that is not awaiting", () => {
		expect(verificationTakeover(lead("a"), [tk("t1", { subjectId: "site-consent:other.example" })])).toBeNull();
		expect(verificationTakeover(lead("a"), [tk("t1", { state: "ended" })])).toBeNull();
		expect(verificationTakeover(lead("a"), [tk("t1", { subjectKind: "runtime_task" })])).toBeNull();
		expect(verificationTakeover(lead("a", { state: "dispatched" }), [tk("t1")])).toBeNull();
		expect(verificationTakeover(lead("a"), [])).toBeNull();
	});
	it("rows needing the owner sort first, the rest keep the server's order", () => {
		const leads = [lead("x", { canonicalUrl: "https://other.example/1" }), lead("y"), lead("z", { canonicalUrl: "https://other.example/2" })];
		expect(orderVerifications(leads, [tk("t1")]).map((v) => v.leadId)).toEqual(["y", "x", "z"]);
		expect(orderVerifications(leads, []).map((v) => v.leadId)).toEqual(["x", "y", "z"]);
	});
});
