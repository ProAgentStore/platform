import { normalize } from "../local-artifact/engine.js";

export interface AnswerSource { label: string; text: string; answerText?: string }
const citizenship = /\bcitizen(?:s|ship)?\b/;
const citizenValue = /^(?:australian|new zealand|australian\s*\/\s*new zealand) citizen$/;
const affirmativeField = /^(?:work authorization|australian working rights|citizenship):\s*((?:australian|new zealand|australian\s*\/\s*new zealand) citizen)(?: with australian work authorization)?\.?$/;
const provenance = /^provenance: user-confirmed corrections are australian citizenship and [a-z /-]+ targeting\.$/;
const plain = (text: string) => normalize(text.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, ""));
const profileMetadata = /^(?:name|first name|last name|email|phone|city|state\/region|country|linkedin|website|us work authorization|salary expectation|target roles \/ titles|target locations|work type \(remote \/ hybrid \/ onsite\)|open to relocation\? \(yes \/ no\)):\s*\S/;
const section = /^(?:candidate profile|profile|personal details|contact|citizenship|work authorization):?$/;
const identityMetadata = /^(?:name|first name|last name|email|phone|linkedin|website):\s*\S/;
const contactRow = (line: string) => line.split("|").length > 1 && line.split("|").every((part) => /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|[+\d() .-]+)$/.test(part.trim().replace(/^[📞📧🔗]\s*/u, "")));
const neutralContinuation = /^(?:i would welcome a discussion\.|i would welcome the chance to discuss how i can help [a-z0-9 &'()-]+(?:'s)? teams deliver on a reliable cadence\.)$/;
// These explicit scope markers qualify adjacent assertions even across paragraph boundaries.
// Unknown wording still cannot establish a fact: only the closed affirmative forms below can.
const correctionContext = /(?:^|[.!?]\s+|\n\s*)(?:correction\s*:|(?:the\s+)?(?:following|previous|above|below|this|that)\s+(?:(?:information|statement|fact|claim|assertion)s?\s+)?(?:is|are)\s+(?:false|incorrect|unconfirmed|uncertain|not true)\b)/i;

export const isCombinedCitizenshipOption = (role: string, label: string) => role === "option" && /^australian\s*\/\s*new zealand citizen$/.test(normalize(label));

/** Source-specific, closed affirmative forms; generated prose can corroborate but never authorize. */
export function observedCitizenshipOption(role: string, label: string, quote: unknown, sources: readonly AnswerSource[] = []): boolean {
	if (!isCombinedCitizenshipOption(role, label)) return false;
	const q = typeof quote === "string" ? normalize(quote) : "";
	const profiles = sources.filter((source) => source.label === "profile");
	const ownerAnswers = sources.filter((source) => source.label === "owner answers" && /\bcitizen(?:s|ship)?\b|working rights|work authorization/i.test(source.text));
	if (ownerAnswers.some((source) => !source.answerText || !citizenValue.test(normalize(source.answerText)))) return false;
	const profileProof = profiles.some((source) => normalize(source.text).includes(q) && source.text.split(/\r?\n/).some((line) => {
		const fact = affirmativeField.exec(plain(line));
		return !!fact && q.includes(fact[1]);
	}));
	const answerProof = ownerAnswers.some((source) => normalize(source.text).includes(q) && q.includes(normalize(source.answerText ?? "")));
	if (!q || (!profileProof && !answerProof)) return false;
	const profileLines = profiles.flatMap((source) => source.text.split(/\r?\n/).map(plain));
	const field = (key: string) => profileLines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
	const city = field("city"), state = field("state/region"), country = field("country");
	const location = city && state && country ? `${city}, ${state}, ${country}` : null;
	for (const source of sources) {
		if (ownerAnswers.includes(source)) continue; // Only actual answerText above establishes this fact, never Q prose.
		if (citizenship.test(normalize(source.text)) && correctionContext.test(source.text)) return false;
		const paragraphs = source.text.split(/\r?\n\s*\r?\n/).filter((part) => part.trim());
		for (let index = 0; index < paragraphs.length; index++) {
			const paragraph = paragraphs[index];
			const lines = paragraph.split(/\r?\n/).map(plain).filter(Boolean);
			if (!lines.some((line) => citizenship.test(line) && !(source.label === "profile" && identityMetadata.test(line)))) continue;
			const previous = index > 0 ? plain(paragraphs[index - 1]) : "";
			if (previous.endsWith(":") && !section.test(previous)) return false;
			if (source.label === "profile" && lines.every((line) => affirmativeField.test(line) || provenance.test(line) || identityMetadata.test(line) || (!citizenship.test(line) && profileMetadata.test(line)))) continue;
			if (source.label === "resume" && lines.every((line) => {
				const columns = line.split(" | ");
				const header = !!location && columns.length === 3 && columns[0] === location && citizenValue.test(columns[1]) && columns[2] === "open to hybrid";
				return affirmativeField.test(line) || contactRow(line) || (lines.length === 1 && citizenValue.test(line)) || header;
			})) continue;
			if (source.label === "cover_letter") {
				const sentences = normalize(paragraph).match(/[^.!?]+[.!?]?/g)?.map((sentence) => sentence.trim()) ?? [];
				const first = sentences[0];
				const positive = ["an australian citizen", "a new zealand citizen"].some((fact) => first === `i am ${fact}.` || (!!city && first === `i am ${fact} based in ${city} and happy to work hybrid.`));
				if (positive && sentences.length <= 2 && sentences.slice(1).every((sentence) => neutralContinuation.test(sentence) && !citizenship.test(sentence))) continue;
			}
			return false; // Includes conflicting/uncertain owner answers; questions never establish facts.
		}
	}
	return true;
}
