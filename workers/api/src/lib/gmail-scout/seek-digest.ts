/**
 * The title and employer a SEEK digest gives each job, read from its plain-text listing (#1251).
 *
 * ── Why a parser, and why this one
 *
 * Two earlier attempts read the wrong line. The nearest line before a SEEK link was a lone `[` (7653fb33),
 * then a suburb, a salary or a bullet ("Richmond, Melbourne VIC", "$141,256 + 12% super"). The links that
 * carry the posting id are not wrapped in anchor text, so since 0bd13716 a digest job showed no title at
 * all. The layout below was read from a real SEEK Job Alerts digest (jobmail@s.seek.com.au, "20 new jobs
 * for … in Melbourne VIC", 2026-10-07), and all 23 of its jobs fit it:
 *
 *     logo                                   ← most blocks; 4 of 23 had none
 *     [https://…/serpLogo]                   ← the employer's logo image
 *
 *     Software Engineer                      ← TITLE: the first text line of the block
 *     KIND ADVISORY PTY LTD                  ← COMPANY: the second
 *
 *     Strong applicant                       ← optional badges ("Posted on 30 Sep 2026", …)
 *
 *     Melbourne VIC                          ← location, then an optional salary
 *     $200,000-$220,000 + super
 *
 *     [https://au.seek.com/job/95103855?savedSearchID=…&tracking=…]   ← ends the block
 *
 * A block runs from the previous job link (or the last `logo` marker inside it) to this job's link, so
 * the title is read from where the listing STARTS, never from what happens to sit next to the link. In
 * the Scout's mailbox the link can follow its `[` on the next line (#1247); both shapes are read.
 *
 * The first job is read only after a `logo` marker: before it is the greeting and the saved-search
 * sentence, and a block start that cannot be placed names no job. Anything that is not a plain line of
 * words — a URL, an image, a badge — is never a title or an employer.
 */
import { providerPostingUrl } from "./provider-redirect.js";

export interface SeekListing {
	title: string;
	company: string | null;
}

/** `[https://…]`, with the URL on the same line or the next (#1247). */
const BRACKETED_URL = /\[\s*(https?:\/\/[^\s\]]+)\s*\]/g;

/** Lines SEEK puts between the employer and the location, and is never a name. */
const BADGE = /^(?:very strong applicant|strong applicant|early applicant|be an early applicant|recently posted|new to you|featured|posted on .+|expiring soon)$/i;

const MAX = 160;

/** A line that can name a job or an employer: words, not a URL, an image or a badge. */
function nameLine(line: string | undefined): string | null {
	const t = (line ?? "").replace(/\s+/g, " ").trim();
	if (!t || t.length > MAX || BADGE.test(t) || /^\[|https?:|^logo$/i.test(t) || !/[\p{L}]/u.test(t)) return null;
	return t;
}

/** Every SEEK job in the text, by canonical posting URL, with the title and employer its listing gives. */
export function seekDigestListings(text: string): Map<string, SeekListing> {
	const out = new Map<string, SeekListing>();
	let blockStart = 0;
	let sawJob = false;
	for (const m of text.matchAll(BRACKETED_URL)) {
		const url = providerPostingUrl(m[1].replace(/&amp;/g, "&"));
		if (!url || !/(^|\.)seek\.co(?:m|m\.au|\.nz)$/i.test(new URL(url).hostname)) continue;
		const block = text.slice(blockStart, m.index);
		blockStart = (m.index ?? 0) + m[0].length;
		const lines = block.split("\n").map((l) => l.trim());
		const logo = lines.map((l) => l.toLowerCase()).lastIndexOf("logo");
		const placed = logo >= 0 || sawJob;
		sawJob = true;
		if (!placed || out.has(url)) continue;
		// Drop the logo image and any URL, including one wrapped so its `[` or `]` sits alone on a line.
		const content = lines.slice(logo + 1).filter((l) => l && !/^\[\s*https?:/i.test(l) && !/^https?:/i.test(l) && !/^[[\]]$/.test(l));
		const title = nameLine(content[0]);
		if (!title) continue;
		out.set(url, { title, company: nameLine(content[1]) });
	}
	return out;
}
