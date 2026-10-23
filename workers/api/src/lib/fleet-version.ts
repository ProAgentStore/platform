/** Is `a` an older release than `b`? Numeric by dotted part; a pre-release suffix is ignored. */
export function olderVersion(a: string, b: string): boolean {
	const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
	return false;
}
