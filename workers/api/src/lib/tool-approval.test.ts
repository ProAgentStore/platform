/**
 * The card an owner reads before approving a held-back connector call (#722).
 *
 * These assertions are about a PRODUCT property, not a formatting preference: an approval whose
 * card does not show the call is a consent dialog with the details removed, and the owner ends up
 * approving the agent rather than the message — the state the gate exists to end.
 */
import { describe, expect, it } from "vitest";
import { getRegistryTool } from "./tool-registry.js";
import { approvalFingerprint, buildApprovalCard, previewArgOrder, queuedCallMessage } from "./tool-approval.js";

const gmailSendSchema = () => getRegistryTool("gmail_send")?.jsonSchema;

describe("previewArgOrder", () => {
	it("uses the tool's own declared order, not the order the model happened to emit", () => {
		const schema = { properties: { to: {}, cc: {}, subject: {}, body: {} } };
		expect(previewArgOrder(schema, { body: "b", to: "t", subject: "s" })).toEqual(["to", "subject", "body"]);
	});

	it("shows an argument the schema does not declare, after the declared ones", () => {
		// The argument is what will be SENT; the schema is only how we know what to call it. Hiding
		// an undeclared one would mean approving a call with a field the card never mentioned.
		const schema = { properties: { to: {} } };
		expect(previewArgOrder(schema, { to: "t", smuggled: "x" })).toEqual(["to", "smuggled"]);
	});

	it("omits absent arguments rather than printing empty rows", () => {
		expect(previewArgOrder({ properties: { to: {}, cc: {} } }, { to: "t" })).toEqual(["to"]);
	});

	it("survives a tool with no schema at all", () => {
		expect(previewArgOrder(null, { a: 1 })).toEqual(["a"]);
		expect(previewArgOrder(undefined, {})).toEqual([]);
	});
});

describe("buildApprovalCard", () => {
	it("shows recipient, subject and body for a real gmail_send — WITHOUT naming gmail anywhere", () => {
		// #722's acceptance criterion ("the board card shows recipient, subject and a body
		// preview"), met by the connector-generic rule rather than by a Gmail special case. The
		// schema order IS to · cc · subject · body, so the right card falls out. If this ever
		// regresses it will be because someone special-cased a connector, which is the trap the
		// owner's 2026-08-22 decision ruled out explicitly.
		const card = buildApprovalCard({
			toolName: "gmail_send",
			connectorLabel: "Gmail",
			schema: gmailSendSchema(),
			args: { to: "hr@example.com", subject: "Following up", body: "Hello there." },
		});
		expect(card.title).toBe("Approve: gmail_send");
		expect(card.description).toBe("to: hr@example.com\nsubject: Following up\nbody: Hello there.");
		expect(card.reasoning).toContain("Nothing has happened yet");
		expect(card.reasoning).toContain("Gmail");
	});

	it("renders a string argument as itself, not as escaped JSON", () => {
		// A body full of \\n is not something a human reads, and this card exists to be read.
		const card = buildApprovalCard({
			toolName: "t",
			connectorLabel: "C",
			schema: { properties: { body: {} } },
			args: { body: "line one\nline two" },
		});
		expect(card.description).toBe("body: line one\nline two");
		expect(card.description).not.toContain("\\n");
	});

	it("marks a truncated argument and says how much it cut", () => {
		const long = "x".repeat(900);
		const card = buildApprovalCard({ toolName: "t", connectorLabel: "C", schema: {}, args: { body: long } });
		expect(card.description).toContain("…");
		expect(card.description).toContain("+300 more characters");
	});

	it("caps the whole description at the same 2000 an ordinary ticket lives under", () => {
		const args = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, "y".repeat(500)]));
		const card = buildApprovalCard({ toolName: "t", connectorLabel: "C", schema: {}, args });
		expect(card.description.length).toBeLessThanOrEqual(2000);
	});

	it("says so plainly when the call takes no arguments", () => {
		const card = buildApprovalCard({ toolName: "t", connectorLabel: "C", schema: {}, args: {} });
		expect(card.description).toBe("This call takes no arguments.");
	});
});

describe("queuedCallMessage — what the MODEL is told", () => {
	const msg = (duplicate = false) =>
		queuedCallMessage({ toolName: "gmail_send", connectorLabel: "Gmail", ticketId: "t-1", duplicate });

	it("leads with the fact that nothing was sent", () => {
		// This is the clause the model paraphrases to the owner, and the one thing it must not get
		// wrong is claiming the send happened.
		expect(msg().startsWith("Nothing has been sent.")).toBe(true);
	});

	it("names the ticket, and forbids both retrying and reporting it as done", () => {
		expect(msg()).toContain("t-1");
		expect(msg()).toContain("Do not retry");
		expect(msg()).toContain("do not report it as done");
	});

	it("says when a duplicate collapsed, so the model does not read silence as a failure to queue", () => {
		expect(msg(true)).toContain("already queued");
		expect(msg(false)).not.toContain("already queued");
	});
});

describe("approvalFingerprint", () => {
	it("is the same call regardless of the order the arguments were built in", () => {
		expect(approvalFingerprint("gmail_send", { to: "a", subject: "b" })).toBe(
			approvalFingerprint("gmail_send", { subject: "b", to: "a" }),
		);
	});

	it("separates a different tool, a different value, and a different field", () => {
		const base = approvalFingerprint("gmail_send", { to: "a" });
		expect(approvalFingerprint("gmail_reply", { to: "a" })).not.toBe(base);
		expect(approvalFingerprint("gmail_send", { to: "b" })).not.toBe(base);
		expect(approvalFingerprint("gmail_send", { to: "a", cc: "c" })).not.toBe(base);
	});
});
