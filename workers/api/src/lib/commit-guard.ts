/**
 * ONE commit guard for both browser loops (#627, #629).
 *
 * ── What was wrong
 *
 * `dryRun` and `readOnly` were enforced on `action.name` — a string the MODEL wrote about the
 * element — while the runner targets `action.ref` and ignores `name` entirely
 * (`packages/browser-runner/src/runner.ts`, `browser_click({ element: label, target: refOf(a) })`:
 * `element` is @playwright/mcp's human-readable description, `target` is what locates). So the
 * guard measured a story about the act, never the act. A nameless click already submitted a real
 * application during a run the owner asked to be a test (`apply-loop.test.ts`, "REFUSES a nameless
 * click"); that fix made `name === ""` a refusal and left a WRONG `name` — a paraphrase, an
 * `aria-label` the model rewrote, a page in French — behaving exactly as it had.
 *
 * And there were two guards with two vocabularies: apply blocked Enter, browse did not, so a
 * read-only agent — whose whole promise is that it cannot change anything — could commit by
 * pressing Enter on a focused form field. `blockedActionReason`'s own docstring predicted this
 * ("two guards would eventually disagree about what committing means, and the weaker one would be
 * the hole"); it had already happened.
 *
 * ── What this is
 *
 * The guard now reads the PAGE's own words, not the model's:
 *
 *  1. `resolveSnapshotElement` looks the brain's `ref` up in the accessibility snapshot the
 *     decision was made from. That line is emitted by @playwright/mcp from the DOM, so its role
 *     and accessible name are the page's, in the page's language, whatever the model claimed.
 *  2. Both the resolved name and the claimed one are tested. A model that mislabels a submit is
 *     caught by the page's name; a snapshot that has gone stale is still covered by the claim.
 *  3. `key` is covered, not only `click` — Enter, NumpadEnter and Return submit a focused form,
 *     and Space activates a focused button.
 *
 * This is still a PREDICTION about what a control will do. The authoritative check is the one at
 * the act boundary in the runner (`packages/browser-runner/src/commit-guard.ts`), which holds the
 * DOM and can ask whether the element actually submits a form and whether that form is a POST.
 * This module is the pre-filter that works against every runner already installed in the field —
 * the published CLI lags the Worker by weeks, so a cloud-only guard is the only half of the fix
 * that is live today.
 */

/**
 * Which promise is being enforced — and, because they are not the same promise, which vocabulary.
 *
 *  • `apply_dry_run` — an application rehearsal. Refuse the FINAL submit only: "Apply", "Next" and
 *    "Continue" are the entry and page-advance buttons on a multi-page ATS, and refusing them
 *    stops the rehearsal before it fills anything, which is the whole capability.
 *  • `task_dry_run` — a browse-task rehearsal. Its commit is a plain click (Confirm / Add / Pay),
 *    with no form to fill first, so the full committing-verb set applies.
 *  • `read_only` — the permanent property of an agent that only ever observes. Same vocabulary as
 *    `task_dry_run`, different message, and it is the only mode where the runner additionally
 *    refuses on a DOM fact rather than a label.
 */
export type CommitMode = "apply_dry_run" | "task_dry_run" | "read_only";

/** A snapshot line's own account of an element: `- button "Submit application" [ref=e42]`. */
export interface ResolvedElement {
	role?: string;
	name?: string;
}

/** Wrap a Latin-script token in Unicode-aware word boundaries. `\b` is ASCII-only, so `\bwyślij\b`
 *  never matches "wyślij" (the trailing `ź` is not a `\w`) — the exact silent-miss this guard is
 *  about, one layer down. Non-Latin scripts get NO boundary: `提交` is embedded in a run of letters
 *  ("立即提交申请") and a lookaround would refuse to match it. */
const wordish = (token: string) => `(?<![\\p{L}\\p{N}])${token}(?![\\p{L}\\p{N}])`;

/**
 * The ENGLISH terminal-submit vocabulary, unchanged from the one that shipped and has been tuned
 * against real ATS pages. "Apply"/"Apply now"/"Next"/"Continue" are deliberately absent: they are
 * the ENTRY button on most multi-page ATS, and blocking them stops a dry run before it fills
 * anything, which is the capability dry run exists to provide.
 */
const TERMINAL_EN =
	"\\bsubmit\\b|\\bfinish\\b|\\bdone\\b|\\bcomplete\\b|\\bconfirm\\b|send application|submit application|easy apply|quick apply|one[- ]?click|1[- ]?click";

/**
 * The same families in the other languages an ATS renders in. The SEND / SUBMIT / CONFIRM / FINISH
 * families only — never the APPLY family (`postuler`, `bewerben`, `candidati`, `solliciteer`,
 * `aplikuj`), for the same reason English "Apply" is absent: those are the entry button.
 *
 * A German or French posting is not exotic. `DRY_RUN_SUBMIT_RE` carried no non-English token at
 * all, so `Envoyer ma candidature` was allowed through by both guards and clicked for real during
 * a test run (#627).
 */
const TERMINAL_LATIN_TOKENS = [
	// fr
	"envoyer", "soumettre", "valider", "finaliser", "terminer", "confirmer",
	// de
	"absenden", "abschicken", "senden", "einreichen", "best[äa]tigen", "abschlie[sß]en", "fertigstellen",
	// es
	"enviar", "confirmar", "finalizar", "completar",
	// pt
	"submeter", "concluir",
	// it
	"invia", "inviare", "conferma", "confermare", "completa", "termina", "finalizza",
	// nl
	"verstuur", "versturen", "verzenden", "indienen", "bevestig", "bevestigen", "voltooien", "afronden",
	// sv / no / da
	"skicka", "sende", "bekr[äae]fta", "bekreft", "bekr[æa]ft", "slutf[öo]r", "fullf[øo]r", "afslut",
	// pl
	"wy[śs]lij", "z[łl]ó[żz]", "potwierd[źz]", "zako[ńn]cz",
	// cs / sk
	"odeslat", "potvrdit", "dokon[čc]it",
	// tr
	"g[öo]nder", "onayla", "tamamla",
	// id / ms
	"kirim", "kirimkan", "ajukan", "konfirmasi",
	// vi
	"g[ửu]i", "n[ộo]p", "hoàn t[ấa]t",
	// ru / uk
	"отправить", "подтвердить", "завершить", "подать",
	// el
	"υποβολή", "αποστολή", "επιβεβαίωση",
];

/** Scripts with no word separators — matched as plain substrings (see {@link wordish}). */
const TERMINAL_SCRIPT_TOKENS = [
	// zh
	"提交", "送出", "确认", "確認", "完成",
	// ja
	"送信", "提出", "完了",
	// ko
	"제출", "보내기", "확인", "완료",
	// ar / he
	"إرسال", "تقديم", "تأكيد", "שליחה", "הגשה",
	// hi / th
	"भेजें", "ส่ง", "ยืนยัน",
];

/** Does this label read as the FINAL submit of an application (dry-run's terminal set)? */
export const TERMINAL_SUBMIT_RE = new RegExp(
	[TERMINAL_EN, ...TERMINAL_LATIN_TOKENS.map(wordish), ...TERMINAL_SCRIPT_TOKENS].join("|"),
	"iu",
);

/**
 * Verbs that COMMIT an irreversible action — the read-only set, and a superset of the terminal
 * one. Read-only is the permanent property of an agent that only ever observes, so it is
 * deliberately fail-safe: a filter button literally labelled "Apply" is refused too. For an agent
 * whose promise is that it cannot act, refusing a harmless click is the cheap error and performing
 * a harmful one is the expensive one.
 */
export const COMMIT_VERB_RE = new RegExp(
	[
		"\\b(confirm|accept|add friend|add|submit|send|post|publish|delete|remove|pay|purchase|buy|apply|approve|agree|save)\\b",
		...TERMINAL_LATIN_TOKENS.map(wordish),
		// the APPLY / PAY families, which the terminal set deliberately omits
		...["postuler", "bewerben", "candidati", "solliciteer", "aplikuj", "aplicar", "postular", "bezahlen", "payer", "pagar", "pagare", "l[öo]schen", "supprimer", "eliminar", "speichern", "enregistrer", "guardar", "salva"].map(wordish),
		...TERMINAL_SCRIPT_TOKENS,
		...["申请", "支付", "删除", "保存", "応募", "支払", "削除", "保存", "지원", "결제", "삭제", "저장"],
	].join("|"),
	"iu",
);

/**
 * The apply loop's POST-FILL terminal set: everything above, plus the labels that are only
 * terminal once the form has been filled. "Apply" is the ENTRY button on most multi-page ATS, and
 * an eSignature/acknowledge step ("I Agree", "Accept") is the common LAST step — so these are safe
 * to treat as a submit only after something has been typed, which is state only the loop holds.
 */
export const POST_FILL_SUBMIT_RE = new RegExp(
	[
		"\\b(apply|submit|send|finish|done|complete|confirm|accept|agree)\\b",
		...TERMINAL_LATIN_TOKENS.map(wordish),
		...["postuler", "bewerben", "candidati", "solliciteer", "aplikuj", "aplicar", "postular", "akzeptieren", "accepter", "aceptar", "zustimmen"].map(wordish),
		...TERMINAL_SCRIPT_TOKENS,
		...["申请", "同意", "応募", "同意する", "지원", "동의"],
	].join("|"),
	"iu",
);

/** Keys that submit a focused form. `NumpadEnter` is accepted by `browser_press_key` and submits
 *  identically; the apply loop's `/^(enter|return)$/i` never matched it. */
export const SUBMIT_KEY_RE = /^(enter|return|numpadenter)$/i;
/** Space activates a focused button — including a submit button. */
export const ACTIVATE_KEY_RE = /^(space|spacebar|\s)$/i;

/**
 * The element a `[ref=eNN]` points at, read out of the accessibility snapshot the brain decided
 * from. @playwright/mcp emits one line per element: `- button "Submit application" [ref=e42]`.
 *
 * Returns null when the ref is absent from the snapshot — which is itself a finding: the brain is
 * acting on an element the page did not show it, and in a mode whose promise is "this cannot
 * commit", an unverifiable target is refused rather than trusted.
 */
export function resolveSnapshotElement(snapshot: string | undefined | null, ref: string | undefined): ResolvedElement | null {
	const id = (ref ?? "").trim();
	if (!snapshot || !id) return null;
	// Anchored on the ref, so the match cannot drift onto a neighbouring line.
	const line = snapshot.split("\n").find((l) => l.includes(`[ref=${id}]`));
	if (!line) return null;
	const m = line.match(/([a-zA-Z]+)\s+"([^"]*)"/);
	if (!m) {
		// A ref with no role/name pair (rare: an unnamed generic). It IS in the snapshot, so the
		// target is real; report it with no name rather than pretending it was not found.
		const role = line.match(/-\s*([a-zA-Z]+)/);
		return { role: role?.[1], name: "" };
	}
	return { role: m[1], name: m[2] };
}

/**
 * The part of a `BrowserAction` this guard reads. Declared here rather than imported from
 * `apply-loop.ts`, which imports THIS module — `import-graph.test.ts` fails on a static cycle even
 * when it is type-only, and the guard depending on the loop it constrains is the wrong direction
 * anyway.
 */
export interface GuardedAction {
	action?: string;
	name?: string;
	ref?: string;
	key?: string;
}

export interface CommitGuardInput {
	mode: CommitMode;
	action: GuardedAction | null | undefined;
	/** The snapshot the decision was made from — the page's own account of the element. */
	snapshot?: string | null;
	/**
	 * Did the runner acknowledge that it enforces the guard at the act boundary (its `/browser/act`
	 * reply carried `commitGuard.supported`)? MEASURED from the runner's own response, never
	 * assumed from a version string.
	 *
	 * It decides one thing only: whether a read-only Enter is refused here. The runner can tell a
	 * GET search form from a POST mutation and refuse only the second, which keeps "type into a
	 * search box and press Enter" — explicitly allowed by the read-only prompt — working. This
	 * module cannot see a form at all, so against a runner too old to enforce it refuses the key
	 * outright. Under-guarding an agent whose entire promise is that it cannot commit is not an
	 * option; costing it one search on an old CLI is.
	 */
	runnerEnforces?: boolean;
}

/**
 * Why this action must not reach the page — the message handed back to the brain INSTEAD of
 * performing it. `null` means "go ahead".
 */
export function commitBlockReason({ mode, action, snapshot, runnerEnforces }: CommitGuardInput): string | null {
	if (!action) return null;
	const readOnly = mode === "read_only";

	if (action.action === "key") {
		const key = String(action.key ?? "").trim();
		// A dry run's keys are decided by `runApplyLoop`, which holds the one piece of state that
		// makes the call: an Enter immediately after an arrow key is an autocomplete ACCEPT, not a
		// submit, and refusing it would break every city/company typeahead. This guard is stateless
		// by construction (it runs inside a journaled workflow step), so it must not second-guess
		// that. Read-only has no such carve-out to protect: it may never commit at all.
		if (!readOnly) return null;
		if (SUBMIT_KEY_RE.test(key) && !runnerEnforces) {
			return `BLOCKED — this agent is READ-ONLY and pressing ${key || "Enter"} submits a focused form. Click the specific control you meant instead (a search or filter is fine), or report what you can already see with finish.`;
		}
		if (ACTIVATE_KEY_RE.test(key) && !runnerEnforces) {
			return "BLOCKED — this agent is READ-ONLY and Space activates the focused control, which may commit. Report what you can already see with finish.";
		}
		return null;
	}

	if (action.action !== "click") return null;

	const claimed = String(action.name ?? "").trim();
	const resolved = resolveSnapshotElement(snapshot, action.ref);
	const pageName = (resolved?.name ?? "").trim();

	// Unverifiable target: the model named nothing AND the ref is not in the snapshot it was given.
	// `name` is documented on the click tool but only `ref` is required and only `ref` locates, so
	// `click({ref:"e88"})` on the final Submit matched nothing in either guard and really submitted
	// a job application during a test run. An unverifiable click is refused rather than trusted.
	if (!claimed && !resolved) {
		if (readOnly) {
			return "BLOCKED — this agent is READ-ONLY and that click targets an element that is not in the current page snapshot, so it cannot be checked. Re-read the snapshot and target an element from it, including its `name`.";
		}
		return mode === "apply_dry_run"
			? 'DRY-RUN (test mode): a click must target an element from the CURRENT snapshot and include its visible `name`, so the final submit can be recognised and blocked. Re-read the snapshot and re-issue this click with the element\'s ref and name.'
			: "DRY RUN (rehearsal): a click must target an element from the CURRENT snapshot and include its visible `name`, so a committing action can be recognised and blocked. Re-read the snapshot and re-issue this click with the element's ref and name.";
	}

	const re = mode === "apply_dry_run" ? TERMINAL_SUBMIT_RE : COMMIT_VERB_RE;
	// The PAGE's name first: it is what the element actually says, in the page's language.
	const hit = [pageName, claimed].find((n) => n && re.test(n));
	if (!hit) return null;
	if (readOnly) {
		return `BLOCKED — this agent is READ-ONLY and can never perform "${hit}". Do not attempt it again or look for another way round it. Report what you can already see: call finish with the values you read, or finish(status:"blocked") if the objective genuinely required changing something.`;
	}
	return mode === "apply_dry_run"
		? 'DRY-RUN (test mode): the final submit is BLOCKED — do not submit. Call finish(status:"ready") now.'
		: `DRY RUN (rehearsal): the committing action "${hit}" is BLOCKED — do not perform it. Call finish(status:"done") now.`;
}

/**
 * The policy the cloud hands to the runner with every guarded action, so the enforcement at the
 * act boundary uses the SAME vocabulary as the pre-filter here rather than a copy that drifts.
 *
 * Sent as regex SOURCE, not a boolean: the runner ships inside a published CLI that the field
 * upgrades on its own schedule (0.4.45 and 0.4.51 were live when this landed), so a vocabulary
 * fixed here has to be able to reach a runner that was built before the word existed. The runner
 * keeps its own copy as a floor for the case where nothing is sent.
 */
export function commitGuardSpec(mode: CommitMode): { mode: "read_only" | "dry_run"; labels: string; flags: string } {
	const re = mode === "apply_dry_run" ? TERMINAL_SUBMIT_RE : COMMIT_VERB_RE;
	// The runner only needs the two ENFORCEMENT shapes, not the three promises: `read_only` adds
	// the structural rule (refuse a click that submits a POST form, whatever it is called), both
	// rehearsals are label-only, because an intermediate page-advance in a rehearsal IS a POST
	// submit and must stay walkable.
	return { mode: mode === "read_only" ? "read_only" : "dry_run", labels: re.source, flags: re.flags };
}

/** The mode a browse task is running under, or null when it is a normal, committing run. */
export function commitModeFor(job: { dryRun?: boolean; readOnly?: boolean } | null | undefined): CommitMode | null {
	// read-only is the stronger, permanent form of the same guard, so it wins when both are set.
	if (job?.readOnly) return "read_only";
	if (job?.dryRun) return "task_dry_run";
	return null;
}
