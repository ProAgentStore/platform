/**
 * The board's first-class ticket affordance (#757): a card that is not yet a ticket offers "Make ticket",
 * which calls the idempotent promote route; a card that is one says so and offers nothing to repeat.
 * Checked on the source, as the console's other wiring tests are — the behaviour behind it (idempotency,
 * owner scoping, stored attempts) is the API's and is tested there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maskComments } from "../lib/jsx-tags.js";

const src = maskComments(readFileSync(new URL("./BoardTab.tsx", import.meta.url), "utf8"));

describe("BoardTab — cards become first-class tickets (#757)", () => {
	it("calls the promote route with the card's key, URL-encoded", () => {
		expect(src).toMatch(/\/v1\/instances\/\$\{instanceId\}\/board\/items\/\$\{encodeURIComponent\(item\.jobKey\)\}\/ticket/);
		expect(src).toMatch(/method: "POST"/);
	});

	it("offers Make ticket only on a card that is not one yet", () => {
		expect(src).toContain("onPromote: item.ticketId ? undefined : () => handlePromote(item)");
		expect((src.match(/Make ticket/g) ?? []).length).toBe(2); // the card and the list row
	});

	it("marks a card that is a ticket, in both views", () => {
		expect((src.match(/\{item\.ticketId && <span/g) ?? []).length).toBe(2);
	});
});
