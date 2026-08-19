import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildAnswerDocument, fillPdfForm, inspectPdfForm, PdfFormError } from "./pdf-form.js";

/**
 * The fixtures are REAL PDFs, built with pdf-lib rather than checked in as base64 blobs.
 *
 * A blob fixture would test the same three bytes forever and tell nobody what shape it had. This
 * way the form under test is readable in the test that uses it, and "a flat PDF with no fields"
 * is expressed as a document with no fields rather than as an opaque string somebody has to
 * trust.
 */

/** A form with one of each interesting field type. */
async function makeForm(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([595, 842]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText("Junior Summer Competition", { x: 50, y: 780, size: 14, font });
	const form = doc.getForm();

	const name = form.createTextField("player_name");
	name.addToPage(page, { x: 50, y: 700, width: 220, height: 18 });

	const day = form.createDropdown("preferred_day");
	day.addOptions(["Saturday", "Sunday"]);
	day.addToPage(page, { x: 50, y: 660, width: 220, height: 18 });

	const member = form.createCheckBox("is_member");
	member.addToPage(page, { x: 50, y: 620, width: 14, height: 14 });

	return doc.save();
}

/** A flat document: text drawn on a page, no AcroForm at all. The scanned-form case. */
async function makeFlat(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([595, 842]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText("Player name: ......................", { x: 50, y: 700, size: 12, font });
	return doc.save();
}

describe("inspectPdfForm", () => {
	it("names every field, its type, and the closed set of values where there is one", async () => {
		const info = await inspectPdfForm(await makeForm());
		expect(info.hasForm).toBe(true);
		expect(info.pageCount).toBe(1);
		const byName = new Map(info.fields.map((f) => [f.name, f]));
		expect(byName.get("player_name")?.type).toBe("text");
		expect(byName.get("is_member")?.type).toBe("checkbox");
		expect(byName.get("preferred_day")).toMatchObject({ type: "dropdown", options: ["Saturday", "Sunday"] });
	});

	it("reports hasForm:false for a flat document instead of pretending", async () => {
		const info = await inspectPdfForm(await makeFlat());
		expect(info.hasForm).toBe(false);
		expect(info.fields).toEqual([]);
	});
});

describe("fillPdfForm", () => {
	it("fills text, dropdown and checkbox fields", async () => {
		const result = await fillPdfForm(await makeForm(), {
			player_name: "Sam Tan",
			preferred_day: "Sunday",
			is_member: true,
		}, { flatten: false });
		expect(result.filled.sort()).toEqual(["is_member", "player_name", "preferred_day"]);
		expect(result.unknown).toEqual([]);

		// Read it back rather than trusting the return value — the assertion that matters is that
		// the VALUE is in the document, not that the call said so.
		const reloaded = await PDFDocument.load(result.bytes);
		const form = reloaded.getForm();
		expect(form.getTextField("player_name").getText()).toBe("Sam Tan");
		expect(form.getDropdown("preferred_day").getSelected()).toEqual(["Sunday"]);
		expect(form.getCheckBox("is_member").isChecked()).toBe(true);
	});

	it("accepts human-ish truthy strings for a checkbox", async () => {
		for (const value of ["yes", "Y", "true", "X", "1", "checked"]) {
			const r = await fillPdfForm(await makeForm(), { is_member: value }, { flatten: false });
			const form = (await PDFDocument.load(r.bytes)).getForm();
			expect(form.getCheckBox("is_member").isChecked(), value).toBe(true);
		}
		const off = await fillPdfForm(await makeForm(), { is_member: "no" }, { flatten: false });
		expect((await PDFDocument.load(off.bytes)).getForm().getCheckBox("is_member").isChecked()).toBe(false);
	});

	it("REPORTS a field name the form does not have, and fills the rest", async () => {
		// The likeliest real mistake: the model guesses playerName for player_name. Silently
		// dropping it produces a blank form that everything claims succeeded.
		const result = await fillPdfForm(await makeForm(), { playerName: "Sam Tan", is_member: true }, { flatten: false });
		expect(result.unknown).toEqual(["playerName"]);
		expect(result.filled).toEqual(["is_member"]);
		expect(result.untouched).toContain("player_name");
	});

	it("refuses a flat PDF rather than handing back an unchanged document", async () => {
		// pdf-lib is perfectly happy to fill nothing and return the input. An agent attaching THAT
		// has sent an empty form while reporting success — the failure this refusal exists for.
		await expect(fillPdfForm(await makeFlat(), { player_name: "Sam Tan" })).rejects.toThrow(PdfFormError);
		await expect(fillPdfForm(await makeFlat(), { player_name: "Sam Tan" })).rejects.toThrow(/no fillable form fields/);
	});

	it("names the allowed values when a closed-set field rejects one", async () => {
		await expect(fillPdfForm(await makeForm(), { preferred_day: "Wednesday" })).rejects.toThrow(/Saturday, Sunday/);
	});

	it("flattens by default, so the values cannot be edited away", async () => {
		const flat = await fillPdfForm(await makeForm(), { player_name: "Sam Tan" });
		// Flattening removes the fields: the values are page content now.
		expect((await inspectPdfForm(flat.bytes)).hasForm).toBe(false);

		const editable = await fillPdfForm(await makeForm(), { player_name: "Sam Tan" }, { flatten: false });
		expect((await inspectPdfForm(editable.bytes)).hasForm).toBe(true);
	});
});

describe("buildAnswerDocument", () => {
	it("produces a readable PDF from label/value pairs", async () => {
		const bytes = await buildAnswerDocument("Summer Competition Entry", [
			{ label: "Player name", value: "Sam Tan" },
			{ label: "Preferred day", value: "Sunday" },
			{ label: "Member of the club", value: "Yes" },
		]);
		expect(bytes.length).toBeGreaterThan(500);
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(1);
	});

	it("adds pages rather than running off the bottom of one", async () => {
		const many = Array.from({ length: 60 }, (_, i) => ({ label: `Question ${i + 1}`, value: `Answer ${i + 1}` }));
		const doc = await PDFDocument.load(await buildAnswerDocument("Long form", many));
		expect(doc.getPageCount()).toBeGreaterThan(1);
	});

	it("survives text the standard fonts cannot encode", async () => {
		// The motivating mail was forwarded from a Chinese iPhone. WinAnsi cannot represent that,
		// and an unhandled drawText throw would mean a 500 instead of a document.
		const bytes = await buildAnswerDocument("报名表 / Entry", [{ label: "姓名 Name", value: "谭三 Sam Tan" }]);
		expect(bytes.length).toBeGreaterThan(500);
	});

	it("renders an empty answer as a dash rather than a blank line", async () => {
		const bytes = await buildAnswerDocument("Entry", [{ label: "Phone", value: "" }]);
		expect(bytes.length).toBeGreaterThan(500);
	});
});

describe("closed-set matching", () => {
	it("matches an option case-insensitively and stores the form's own spelling", async () => {
		const r = await fillPdfForm(await makeForm(), { preferred_day: "  sunday " }, { flatten: false });
		const form = (await PDFDocument.load(r.bytes)).getForm();
		// Not "sunday" — the document's own casing, which is what a human reads back.
		expect(form.getDropdown("preferred_day").getSelected()).toEqual(["Sunday"]);
		expect(r.filled).toEqual(["preferred_day"]);
	});

	it("does not invent a new option, which is what pdf-lib does left to itself", async () => {
		await expect(fillPdfForm(await makeForm(), { preferred_day: "Wednesday" })).rejects.toThrow(PdfFormError);
		// The failure has to name the real choices or the model cannot correct itself.
		await expect(fillPdfForm(await makeForm(), { preferred_day: "Wednesday" })).rejects.toThrow(/Saturday, Sunday/);
	});
});
