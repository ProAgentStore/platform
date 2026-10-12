/**
 * What a Worker's triggers ARE on Cloudflare after a deploy, checked against its wrangler.toml (#1046).
 *
 * `wrangler deploy` can upload the Worker and then fail on one trigger (`pags-job-apply`, run for
 * bb7c11e0): the release is then partly applied, and neither "green" nor "red" says which part. This
 * reads the final state back — every `[[workflows]]` entry must exist, be bound to this script and
 * class, and the `[triggers] crons` must be the Worker's schedules — so the run states it explicitly.
 */

/** Unquote a TOML basic string or a one-line array of them. Enough for the keys read here. */
function value(raw) {
	const v = raw.trim();
	if (v.startsWith("[")) return [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
	const s = /^"((?:[^"\\]|\\.)*)"/.exec(v);
	return s ? s[1] : v;
}

/**
 * The subset of wrangler.toml this check needs: the script `name`, `[triggers] crons`, and each
 * `[[workflows]]` entry's `name`, `class_name` and optional `script_name`.
 */
export function parseWranglerConfig(text) {
	const config = { name: null, crons: [], workflows: [] };
	let section = "";
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?$/.exec(t);
		if (header) {
			section = header[2];
			if (header[1] === "[[" && section === "workflows") config.workflows.push({});
			continue;
		}
		const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(t);
		if (!kv) continue;
		const [, key, raw] = kv;
		if (section === "" && key === "name") config.name = value(raw);
		else if (section === "triggers" && key === "crons") config.crons = value(raw);
		else if (section === "workflows") config.workflows.at(-1)[key] = value(raw);
	}
	return {
		name: config.name,
		crons: config.crons,
		workflows: config.workflows.map((w) => ({ name: w.name, className: w.class_name, scriptName: w.script_name ?? config.name })),
	};
}

/**
 * Compare the deployed state to the config. `getWorkflow(name)` resolves to the Cloudflare workflow
 * object, or null when Cloudflare says it does not exist; `getSchedules()` to the Worker's cron
 * strings. Either may throw — a read that fails is reported `unverified`, never as a pass.
 */
export async function checkTriggers(config, { getWorkflow, getSchedules }) {
	const rows = [];
	for (const wf of config.workflows) {
		try {
			const got = await getWorkflow(wf.name);
			if (!got) rows.push({ trigger: `workflow ${wf.name}`, state: "missing", detail: "Cloudflare has no workflow by this name" });
			else if (got.script_deleted) rows.push({ trigger: `workflow ${wf.name}`, state: "wrong", detail: `its script ${got.script_name} is deleted` });
			else if (got.script_name !== wf.scriptName || got.class_name !== wf.className)
				rows.push({ trigger: `workflow ${wf.name}`, state: "wrong", detail: `bound to ${got.script_name}/${got.class_name}, expected ${wf.scriptName}/${wf.className}` });
			else rows.push({ trigger: `workflow ${wf.name}`, state: "ok", detail: `${got.script_name}/${got.class_name}` });
		} catch (error) {
			rows.push({ trigger: `workflow ${wf.name}`, state: "unverified", detail: error.message });
		}
	}
	try {
		const deployed = [...(await getSchedules())].sort();
		const expected = [...config.crons].sort();
		const same = deployed.length === expected.length && deployed.every((c, i) => c === expected[i]);
		rows.push({ trigger: "crons", state: same ? "ok" : "wrong", detail: same ? expected.join(", ") || "none" : `deployed [${deployed.join(", ")}], expected [${expected.join(", ")}]` });
	} catch (error) {
		rows.push({ trigger: "crons", state: "unverified", detail: error.message });
	}
	return { ok: rows.every((r) => r.state === "ok"), rows };
}

/** Retry a read on throw — the verification must not itself be a casualty of the blip it checks for. */
export async function withRetry(read, { attempts = 3, sleep, delayMs = 5_000 }) {
	let last;
	for (let n = 1; n <= attempts; n++) {
		try {
			return await read();
		} catch (error) {
			last = error;
			if (n < attempts) await sleep(delayMs * n);
		}
	}
	throw last;
}
