/**
 * The transfer channel (#279) — the shape, and the property that makes it safe.
 *
 * The interesting assertions here are the STRUCTURAL ones at the bottom. A transfer is the first
 * thing an agent can do to the CLIENT rather than to the world, and the platform spent a commit
 * (`2532f00`, #386) closing the accidental version of that class. What keeps the deliberate one
 * safe is not a rule the model follows: it is that a destination can only travel on the response
 * to a chat turn, which exists only because the user just spoke. That is a property of WHERE the
 * field is attached, so it is asserted over the source — a unit test on a pure function cannot see
 * someone adding the field to a broadcast, a notification or the message list.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "./source-guard.js";
import { runRegistryTool } from "./tool-registry.js";
import type { Env } from "../types.js";
import {
	MAX_TRANSFER_NOTE,
	buildTransfer,
	describeTransfer,
	sanitizeTransferNote,
	transferFromToolResults,
	type ConversationTransfer,
} from "./conversation-transfer.js";

const DEST = { instanceId: "inst-fws", name: "FWS platform" };

describe("sanitizeTransferNote", () => {
	it("keeps an ordinary sentence intact", () => {
		expect(sanitizeTransferNote("about the SSE ordering bug")).toBe("about the SSE ordering bug");
	});

	it("is empty for anything that is not a string — a missing note is not a reason to refuse a move", () => {
		for (const bad of [undefined, null, 42, {}, ["x"]]) expect(sanitizeTransferNote(bad)).toBe("");
	});

	it("flattens a note the model formatted as a list, because this is spoken", () => {
		expect(sanitizeTransferNote("about:\n  - the bug\n  - the fix")).toBe("about: - the bug - the fix");
	});

	it("removes control characters, which would travel intact into a spoken line", () => {
		expect(sanitizeTransferNote("about\u0000the\u001bbug")).toBe("about the bug");
	});

	it("caps the length — a model handed an unbounded string writes a paragraph", () => {
		expect(sanitizeTransferNote("x".repeat(500))).toHaveLength(MAX_TRANSFER_NOTE);
	});
});

describe("buildTransfer", () => {
	it("carries the resolved id and name, never whatever the model typed", () => {
		// The destination is resolved server-side against the supervision graph before this runs;
		// this function only ever sees the row that came back. A name the model wrote could not
		// reach `instanceId` even if it wanted to.
		expect(buildTransfer(DEST, "  about the bug  ")).toEqual({ instanceId: "inst-fws", name: "FWS platform", note: "about the bug" });
	});
});

describe("describeTransfer", () => {
	it("tells the model the move has already happened", () => {
		// It has: the destination leaves with the response this result is part of. A model that
		// thinks it still has to act will keep talking to somebody who is no longer there.
		const out = describeTransfer(buildTransfer(DEST, "about the bug"));
		expect(out).toContain("FWS platform");
		expect(out).toContain("inst-fws");
		expect(out).toMatch(/no longer reading/i);
	});
});

describe("transferFromToolResults — no tool call, no transfer", () => {
	const t: ConversationTransfer = { instanceId: "inst-fws", name: "FWS platform", note: "" };

	it("is null for a turn that ran no tools at all", () => {
		// The assertion that keeps the channel honest: every other way a chat response is produced
		// — a plain answer, an error, a loop step — comes through here and gets nothing.
		expect(transferFromToolResults([])).toBeNull();
	});

	it("is null for a turn whose other tools succeeded", () => {
		expect(transferFromToolResults([{ success: true }, { success: true }])).toBeNull();
	});

	it("ignores a FAILED transfer — a refusal must not move anybody", () => {
		// "You do not supervise that agent" is the resolver's answer to an unresolvable name, and
		// it arrives with the field absent; this is the belt to that braces.
		expect(transferFromToolResults([{ success: false, transfer: t }])).toBeNull();
	});

	it("takes the last one when a model called it twice — the browser can only go one place", () => {
		const second: ConversationTransfer = { instanceId: "inst-fas", name: "FAS platform", note: "" };
		expect(transferFromToolResults([{ success: true, transfer: t }, { success: true, transfer: second }])).toEqual(second);
	});
});

// ── The structural half: WHERE a transfer may be attached ────────────────────────────
//
// A pure test cannot see a future commit putting this field on a channel the client polls. These
// can, and they fail with the offender named.

interface Source {
	rel: string;
	/** Comments, string literals and regex literals blanked — so a mention in prose is not a hit. */
	code: string;
}

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src

function sources(dir = SRC, out: Source[] = []): Source[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			sources(p, out);
			continue;
		}
		if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts")) continue;
		out.push({ rel: p.slice(SRC.length), code: stripCommentsAndLiterals(readFileSync(p, "utf-8")) });
	}
	return out;
}

const ALL = sources();

describe("the write-consent gate covers it like every other write tool", () => {
	it("refuses with no consent, and carries no destination when it refuses", async () => {
		// Deliberately NOT special-cased: moving the person is the most consequential thing the
		// supervision connector does, so "this agent may move me" is opted into once, in the place
		// the owner opted into everything else (#90). An empty env has no consent row.
		const r = await runRegistryTool("transfer_conversation", { env: {} as Env, userId: "u1", instanceId: "i1" }, { instanceId: "FWS platform" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/supervision/);
		expect(r.transfer).toBeUndefined();
	});
});

describe("the response is the only channel a transfer can travel on", () => {
	/**
	 * The modules that may mention the field, and what each one does with it. Compared EXACTLY, so
	 * deleting a legitimate one fails here too and the list can only change deliberately.
	 *
	 * Note what is NOT here and must never be: anything that writes a message, broadcasts over the
	 * WebSocket, raises a notification, or answers a poll. Those are read without the user having
	 * spoken, which is precisely the spontaneous-transfer class this design exists to exclude —
	 * `notifyUser` + the `next` command is the offer, and it is already gated on a spoken word.
	 */
	const CARRIERS: Record<string, string> = {
		"lib/conversation-transfer.ts": "the shape and the rules — this module",
		"lib/connectors/types.ts": "declares the optional field on a tool result",
		"lib/connectors/supervision.ts": "transfer_conversation — the only tool that produces one",
		"lib/tool-registry.ts": "passes it through from the handler, untouched",
		"agent-think.ts": "lifts it off the turn's tool results",
		"agent-do.ts": "attaches it to the chat turn's response, and to nothing else",
	};

	it("no module outside the response path names the field", () => {
		const offenders = ALL.filter((f) => !CARRIERS[f.rel] && /\btransfer\b/.test(f.code)).map((f) => f.rel);
		expect(
			offenders,
			"A transfer may only travel on the response to a chat turn — that is what makes it consumed-once\n" +
				"and impossible to deliver without the user having spoken (see lib/conversation-transfer.ts).\n" +
				"If you are adding a legitimate hop, add it to CARRIERS with the reason. If you are adding it to\n" +
				"a broadcast, a notification, a stored message or a poll response, do not: that is the channel\n" +
				`#279 deliberately declined to build.\nOffenders:\n${offenders.sort().join("\n")}`,
		).toEqual([]);
	});

	it("agent-think keeps the client half out of what the model and the broadcast see", () => {
		// The bug this catches, seen once already while writing it: the accumulator existed and
		// nothing pushed to it, so the tool ran, the destination was built, and the response carried
		// nothing — a feature that is silently inert everywhere except its own unit tests. The
		// second assertion is the other half: `toolResult` is rebuilt field by field, because
		// passing the whole registry result through would put a client directive on the `tool_call`
		// broadcast, which is a push channel.
		const think = ALL.find((f) => f.rel === "agent-think.ts");
		expect(think?.code, "the turn no longer records its registry results — the destination cannot reach the response").toMatch(/registryResults\.push\(/);
		expect(think?.code, "the registry result is handed to the model whole again — a directive can ride the tool_call broadcast").not.toMatch(/toolResult = await runRegistryTool/);
		expect(think?.code, "the destination is no longer read back out at the turn's exits").toMatch(/transferFromToolResults\(registryResults\)/);
	});

	it("agent-do attaches it to the chat turn and to nothing else", () => {
		const doTs = ALL.find((f) => f.rel === "agent-do.ts");
		expect(doTs, "agent-do.ts moved — this guard is now looking at nothing").toBeTruthy();
		const uses = (doTs?.code ?? "")
			.split("\n")
			.map((l, i) => [l, i + 1] as const)
			.filter(([l]) => /\btransfer\b/.test(l));
		expect(uses.length, "agent-do.ts no longer mentions a transfer at all — the wiring is gone").toBeGreaterThan(0);
		for (const [line] of uses) {
			// Two forms only: destructuring it off `think`, and spreading it onto the turn's `json`.
			expect(
				/const \{ response, toolCalls, transfer \}/.test(line) ||
					/Promise<\{ response: string; toolCalls: string\[\]; transfer\?/.test(line) ||
					/return json\(\{ message: assistantMsg, toolMessage: toolMsg, \.\.\.\(transfer \? \{ transfer \} : \{\}\) \}\)/.test(line),
				`agent-do.ts uses a transfer somewhere other than the chat turn's response:\n  ${line.trim()}`,
			).toBe(true);
		}
	});
});
