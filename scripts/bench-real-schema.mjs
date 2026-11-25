// Diagnostic for #1726: where does a real-schema test spend its time on a given machine? Run by .github/workflows/windows-measure.yml.
// Times each phase of workers/api/src/lib/d1-sqlite.ts realSchemaD1() separately, under each (synchronous x journal_mode) variant.
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = join(import.meta.dirname, "..", "workers", "api", "migrations");
const DIR = join(tmpdir(), `pags-bench-${process.pid}`);
mkdirSync(DIR, { recursive: true });
const files = readdirSync(MIGRATIONS)
	.filter((f) => f.endsWith(".sql"))
	.sort();
const sources = files.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")]);

const time = (fn) => {
	const t0 = performance.now();
	const r = fn();
	return [Number((performance.now() - t0).toFixed(1)), r];
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const repeat = (n, fn) => median(Array.from({ length: n }, () => time(fn)[0]));

console.log(`tmp dir: ${DIR}`);
console.log(`migrations: ${files.length}, chars: ${sources.reduce((n, [, s]) => n + s.length, 0)}, node ${process.version}`);

const hashWithProbe = () => {
	const h = createHash("sha256");
	const p = new DatabaseSync(":memory:");
	h.update(p.prepare("SELECT sqlite_version() AS v").get().v);
	p.close();
	for (const [n, s] of sources) h.update(n).update("\0").update(s);
	return h.digest("hex");
};
const hashOnly = () => {
	const h = createHash("sha256");
	for (const [n, s] of sources) h.update(n).update("\0").update(s);
	return h.digest("hex");
};
console.log(`migrationsContentHash per call (probe + sha256): ${repeat(20, hashWithProbe)} ms; sha256 alone: ${repeat(20, hashOnly)} ms`);

for (const sync of ["OFF", "NORMAL", "FULL"]) {
	for (const journal of ["DELETE", "WAL"]) {
		const template = join(DIR, `template-${sync}-${journal}.db`);
		const [buildMs] = time(() => {
			const db = new DatabaseSync(template);
			db.exec(`PRAGMA synchronous = ${sync}; PRAGMA journal_mode = ${journal}`);
			for (const [, sql] of sources) db.exec(sql);
			db.close();
		});
		const copy = [];
		const open = [];
		const ins = [];
		const insTx = [];
		const close = [];
		const rm = [];
		for (let i = 0; i < 5; i++) {
			const clone = join(DIR, `clone-${randomBytes(4).toString("hex")}.db`);
			copy.push(time(() => copyFileSync(template, clone))[0]);
			let db;
			open.push(
				time(() => {
					db = new DatabaseSync(clone);
					db.exec(`PRAGMA synchronous = ${sync}; PRAGMA journal_mode = ${journal}`);
				})[0],
			);
			db.exec("CREATE TABLE bench (id INTEGER PRIMARY KEY, v TEXT)");
			// 1,200 autocommit single-row inserts: the shape of history-retrieval.test.ts.
			ins.push(
				time(() => {
					const st = db.prepare("INSERT INTO bench (v) VALUES (?)");
					for (let k = 0; k < 1200; k++) st.run(`row-${k}`);
				})[0],
			);
			insTx.push(
				time(() => {
					db.exec("BEGIN");
					const st = db.prepare("INSERT INTO bench (v) VALUES (?)");
					for (let k = 0; k < 1200; k++) st.run(`row-${k}`);
					db.exec("COMMIT");
				})[0],
			);
			close.push(time(() => db.close())[0]);
			rm.push(time(() => rmSync(clone, { force: true }))[0]);
			rmSync(`${clone}-wal`, { force: true });
			rmSync(`${clone}-shm`, { force: true });
		}
		console.log(
			`synchronous=${sync} journal_mode=${journal}: template build ${buildMs} ms | per clone, median of 5 (ms): copy ${median(copy)}, open+pragma ${median(open)}, 1200 autocommit inserts ${median(ins)}, 1200 inserts in one tx ${median(insTx)}, close ${median(close)}, rm ${median(rm)}`,
		);
	}
}
rmSync(DIR, { recursive: true, force: true });
