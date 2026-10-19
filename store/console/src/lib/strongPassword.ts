/**
 * A strong password for a site login the owner rotates from the console (#1226). Generated in the
 * browser from `crypto.getRandomValues`, so it exists only on this page until it is saved to the
 * encrypted vault. Twenty characters, always with a lower, an upper, a digit and a symbol — the
 * mix most sign-up forms insist on — from an alphabet without look-alikes (0/O, 1/l/I), since the
 * owner may need to read it off one screen and type it on another.
 */
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^&*-_=+?";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

type Random = (out: Uint32Array) => Uint32Array;

/** A uniform integer in [0, n): rejection sampling, so no value is likelier than another. */
function uniform(n: number, random: Random): number {
	const limit = Math.floor(0x1_0000_0000 / n) * n;
	const buf = new Uint32Array(1);
	for (;;) {
		const v = random(buf)[0];
		if (v < limit) return v % n;
	}
}

export function strongPassword(length = 20, random: Random = (out) => crypto.getRandomValues(out)): string {
	const from = (set: string) => set[uniform(set.length, random)];
	const chars = [from(LOWER), from(UPPER), from(DIGIT), from(SYMBOL)];
	while (chars.length < length) chars.push(from(ALL));
	// Fisher–Yates, so the four guaranteed classes are not always the first four characters.
	for (let i = chars.length - 1; i > 0; i--) {
		const j = uniform(i + 1, random);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.join("");
}
