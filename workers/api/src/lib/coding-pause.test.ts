import { describe, expect, it } from "vitest";
import {
	HANDOFF_GIVE_UP_MS,
	HANDOFF_POLL_MS,
	HANDOFF_WAIT_POLLS,
	resolvePause,
	runSucceeded,
	stopReasonFor,
	type PauseDeps,
} from "./coding-pause.js";
import { ENGINE_WAIT_TICK_MS, ENGINE_WAIT_TOTAL_MS, MAX_ENGINE_WAITS } from "./coding-wait.js";
import { statusFor } from "./agent-loop.js";
import type { CodingResult } from "./coding-loop.js";

const NOW = Date.parse("2026-08-12T11:34:00Z");

interface Spy {
	deps: PauseDeps;
	slept: number[];
	announced: string[];
	notified: Array<{ title: string; alert: boolean }>;
	ticks: number;
	takeovers: number;
	endTakeovers: number;
	/** Every board-card transition the pause machine asked for, in order (#553). */
	cards: string[];
}

function spy(over: Partial<{ resolveAfter: number; cancelAfterTicks: number; timeZone: string }> = {}): Spy {
	const s: Spy = {
		slept: [],
		announced: [],
		notified: [],
		ticks: 0,
		takeovers: 0,
		endTakeovers: 0,
		cards: [],
		deps: null as unknown as PauseDeps,
	};
	let polls = 0;
	s.deps = {
		repo: "heartfull/platform",
		timeZone: over.timeZone,
		now: () => NOW,
		takeover: async () => {
			s.takeovers++;
		},
		takeoverStatus: async () => ({ resolved: over.resolveAfter !== undefined && ++polls >= over.resolveAfter, value: "typed by hand" }),
		endTakeover: async () => {
			s.endTakeovers++;
		},
		sleep: async (_label, ms) => {
			s.slept.push(ms);
		},
		notify: async (title, _body, _key, alert) => {
			s.notified.push({ title, alert });
		},
		announce: async (m) => {
			s.announced.push(m);
		},
		card: async (status) => {
			s.cards.push(status);
		},
		tick: async () => {
			s.ticks++;
			return over.cancelAfterTicks === undefined || s.ticks < over.cancelAfterTicks;
		},
	};
	return s;
}

const waitingResult = (waitUntil?: string): CodingResult => ({
	outcome: "waiting",
	// The sentence the platform's own handoff notification carried on 2026-08-12 (#541).
	detail: "The Claude CLI session has hit its usage limit and resets at 10:30pm Australia/Sydney time.",
	waitUntil,
	steps: 0,
});

describe("resolvePause — the Engine's usage limit parks the run instead of killing it (#541)", () => {
	it("sleeps to the reported reset and resumes the SAME objective", async () => {
		const s = spy({ timeZone: "Australia/Sydney" });
		const state = { waits: 0, spentMs: 0 };
		const v = await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state });

		expect(v.resume).toBe(true);
		// 56 minutes, in five-minute ticked chunks — the run 6550f673 died 41 minutes short of.
		expect(s.slept.reduce((a, b) => a + b, 0)).toBe(56 * 60_000);
		expect(s.slept.every((ms) => ms <= ENGINE_WAIT_TICK_MS)).toBe(true);
		expect(state).toEqual({ waits: 1, spentMs: 56 * 60_000 });
	});

	it("heartbeats the claims a parked run holds on EVERY chunk", async () => {
		// A park has to out-tick three clocks: the driver claim (15 min), the run sweeper (3h) and
		// the idle-session reaper (6h). One tick per chunk is what does all three.
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state: { waits: 0, spentMs: 0 } });
		expect(s.ticks).toBe(s.slept.length);
		expect(s.slept.length).toBe(Math.ceil((56 * 60_000) / ENGINE_WAIT_TICK_MS));
	});

	it("is cancellable mid-park", async () => {
		const s = spy({ cancelAfterTicks: 3 });
		const v = await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state: { waits: 0, spentMs: 0 } });
		expect(v.resume).toBe(false);
		expect(v.resume === false && v.result.outcome).toBe("cancelled");
		expect(s.ticks).toBe(3);
	});

	it("hands the resumed round a note saying the visible limit message is history", async () => {
		const s = spy({ timeZone: "Australia/Sydney" });
		const v = await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state: { waits: 0, spentMs: 0 } });
		expect(v.resume === true && v.resumeNote).toMatch(/HISTORY/);
		// Never `userHint`: that renders as "The user just told you", and attributing a platform
		// action to the human is what #505 stamps reports for.
		expect(v.resume === true && v.userHint).toBeUndefined();
	});

	it("tells the owner in the thread, and pings WITHOUT the alert kind", async () => {
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state: { waits: 0, spentMs: 0 } });
		expect(s.announced[0]).toMatch(/pausing, not stopping/);
		expect(s.announced.at(-1)).toMatch(/Resuming/);
		// Nothing is being asked of him — a park that pings like a question is how people learn to
		// stop reading these.
		expect(s.notified).toEqual([{ title: "⏸ Coder is waiting on the CLI's usage limit", alert: false }]);
	});

	it("never opens a takeover for a limit no human can resolve", async () => {
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: waitingResult("2026-08-12T22:30:00+10:00"), state: { waits: 0, spentMs: 0 } });
		expect(s.takeovers).toBe(0);
	});

	it("ends the run — NOT as `failed` — once the wait budget is spent", async () => {
		const s = spy();
		const v = await resolvePause(s.deps, {
			round: 0,
			result: waitingResult("2026-08-12T22:30:00+10:00"),
			state: { waits: MAX_ENGINE_WAITS, spentMs: ENGINE_WAIT_TOTAL_MS },
		});
		expect(v.resume).toBe(false);
		expect(v.resume === false && v.result.outcome).toBe("waiting");
		expect(v.resume === false && v.result.detail).toMatch(/still reporting its own usage limit/);
		expect(s.slept).toEqual([]);
	});
});

describe("resolvePause — a human handoff still times out, and is reported as waiting on the human", () => {
	const stuck: CodingResult = { outcome: "stuck", detail: "Not inside a trusted directory", steps: 2 };

	it("resumes when the human takes over, recording the owner turn", async () => {
		const s = spy({ resolveAfter: 2 });
		const v = await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(v.resume).toBe(true);
		expect(v.resume === true && v.ownerTurn).toBe(true);
		expect(s.takeovers).toBe(1);
		expect(s.endTakeovers).toBe(1);
	});

	it("carries a needs_input value back as the user hint it really is", async () => {
		const s = spy({ resolveAfter: 1 });
		const needsInput: CodingResult = { outcome: "needs_input", fieldNeeded: "DEPLOY_TOKEN", steps: 1 };
		const v = await resolvePause(s.deps, { round: 0, result: needsInput, state: { waits: 0, spentMs: 0 } });
		expect(v.resume === true && v.userHint).toBe("DEPLOY_TOKEN: typed by hand");
	});

	it("still bounds the wait at 15 minutes — this is the case that number is RIGHT for", async () => {
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(s.slept.length).toBe(HANDOFF_WAIT_POLLS);
		expect(s.slept.reduce((a, b) => a + b, 0)).toBe(HANDOFF_WAIT_POLLS * HANDOFF_POLL_MS);
		expect(s.slept.reduce((a, b) => a + b, 0)).toBe(15 * 60_000);
	});

	it("reports the expiry as WAITING ON YOU, keeping the outcome out of `failed`", async () => {
		const s = spy();
		const v = await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(v.resume).toBe(false);
		expect(v.resume === false && v.result.outcome).toBe("stuck");
		expect(v.resume === false && v.result.detail).toMatch(/^Waiting on you/);
		// The old text. A run nobody answered was reported as a failure, which is what had the owner
		// re-typing Retry on runs that were never broken.
		expect(v.resume === false && v.result.detail).not.toMatch(/not resolved in time/);
	});

	it("says so in the CHAT THREAD, not only the notification tray (#541 item d)", async () => {
		const s = spy({ resolveAfter: 1 });
		await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(s.announced.some((m) => m.includes("Coder needs you"))).toBe(true);
		expect(s.notified).toEqual([{ title: "🙋 Coder needs you", alert: true }]);
	});

	it("tells the owner BY WHEN, because a handoff deadline they cannot see is one they cannot beat (#596 AC2)", async () => {
		// The asymmetry this closes: the usage-limit park — which needs nothing from anybody —
		// announced its resume time in this same thread, while the one wait a person can actually
		// resolve said only "take over". The bound existed from the first line of the wait and was
		// visible nowhere until it expired.
		const s = spy({ resolveAfter: 1 });
		await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		const line = s.announced.find((m) => m.includes("Coder needs you")) ?? "";
		expect(line, "the handoff announcement states no deadline").toContain(`${HANDOFF_GIVE_UP_MS / 60_000} minutes`);
		// And says what happens at it. A bare time reads as the good kind of deadline — that is the
		// whole of #596 — so the consequence is named beside it.
		expect(line).toMatch(/stops and reports/);
	});

	it("states the same bound in the announcement and in the expiry, from one constant", async () => {
		// Three hand-written "15 minutes" against a poll count is the drift this ticket is about,
		// one level down: the number that is announced must be the number that is enforced.
		const s = spy();
		const v = await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(HANDOFF_GIVE_UP_MS).toBe(s.slept.reduce((a, b) => a + b, 0));
		const announced = s.announced.find((m) => m.includes("Coder needs you")) ?? "";
		const expiry = (v.resume === false && v.result.detail) || "";
		const minutes = `${HANDOFF_GIVE_UP_MS / 60_000} minutes`;
		expect(announced).toContain(minutes);
		expect(expiry).toContain(minutes);
	});

	it("heartbeats during the handoff wait too — the claim it holds expires at 15 minutes", async () => {
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(s.ticks).toBeGreaterThan(1);
	});

	it("is cancellable during the handoff wait", async () => {
		const s = spy({ cancelAfterTicks: 2 });
		const v = await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(v.resume === false && v.result.outcome).toBe("cancelled");
	});

	it("puts the card in Needs you the moment the handoff opens, and back when it resolves (#553)", async () => {
		// The defect this closes: `notifyUser` fired for all four handoffs (`pushed_at` set on every
		// row, verified in production) and "Needs you" stayed EMPTY the whole time three runs sat
		// waiting. The notification is a push — it lands in a tray and is gone. The board is the
		// durable surface, and it is the one with a column named for this state.
		const s = spy({ resolveAfter: 2 });
		await resolvePause(s.deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(s.cards).toEqual(["needs_human", "running"]);
	});

	it("writes the card BEFORE the two pushes, so a later throw cannot lose the durable half", async () => {
		// Ordering matters, and it is the ordering the incident argues for: if the notify or the
		// announce throws, the record still says the run is waiting on somebody. Reverse them and a
		// failure reproduces #553 exactly — the tray knows and the board does not.
		const order: string[] = [];
		const s = spy({ resolveAfter: 1 });
		const deps = {
			...s.deps,
			card: async (st: "needs_human" | "running") => {
				order.push(`card:${st}`);
			},
			notify: async () => {
				order.push("notify");
			},
			announce: async () => {
				order.push("announce");
			},
		};
		await resolvePause(deps, { round: 0, result: stuck, state: { waits: 0, spentMs: 0 } });
		expect(order.slice(0, 3)).toEqual(["card:needs_human", "notify", "announce"]);
	});

	it("leaves the card alone for a usage-limit park — nothing is being asked of anyone", async () => {
		// #541 is explicit that an engine-limit wait must not ping like a question. The same
		// reasoning applies to the column: it reopens by itself, so "Needs you" would be a lie and
		// a column that asks for attention it does not need stops being read.
		const s = spy();
		await resolvePause(s.deps, { round: 0, result: waitingResult(), state: { waits: 0, spentMs: 0 } });
		expect(s.cards).toEqual([]);
	});

	it("hands a terminal outcome straight back without pausing anything", async () => {
		const s = spy();
		const done: CodingResult = { outcome: "done", detail: "shipped", steps: 4 };
		const v = await resolvePause(s.deps, { round: 0, result: done, state: { waits: 0, spentMs: 0 } });
		expect(v).toEqual({ resume: false, result: done });
		expect(s.slept).toEqual([]);
		expect(s.announced).toEqual([]);
	});
});

describe("how an outcome is reported", () => {
	it("tells a clock apart from a person, which is the whole point of #541", () => {
		// Acceptance criterion 2: a genuine human handoff and an exhausted usage-limit wait must be
		// distinguishable in `check_instance_loop`'s stopReason. They are, and neither says `failed`.
		expect(stopReasonFor("stuck")).toBe("escalated");
		expect(stopReasonFor("needs_input")).toBe("escalated");
		expect(stopReasonFor("waiting")).toBe("engine_limit");
		expect(stopReasonFor("stuck")).not.toBe(stopReasonFor("waiting"));
	});

	it("puts both of them in the column that means someone should look", () => {
		expect(statusFor("escalated")).toBe("needs_human");
		expect(statusFor("engine_limit")).toBe("needs_human");
	});

	it("keeps the pre-existing mapping for every outcome that could already reach it", () => {
		expect(stopReasonFor("done")).toBe("done");
		expect(stopReasonFor("failed")).toBe("failed");
		expect(stopReasonFor("cancelled")).toBe("cancelled");
		expect(stopReasonFor("max_steps")).toBe("max_iterations");
	});

	it("does not greet a run that stopped waiting on the owner with a tick", () => {
		expect(runSucceeded("done")).toBe(true);
		expect(runSucceeded("cancelled")).toBe(true);
		expect(runSucceeded("stuck")).toBe(false);
		expect(runSucceeded("needs_input")).toBe(false);
		expect(runSucceeded("waiting")).toBe(false);
		expect(runSucceeded("failed")).toBe(false);
		expect(runSucceeded("max_steps")).toBe(false);
	});
});
