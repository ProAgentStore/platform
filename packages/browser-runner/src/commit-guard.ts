/**
 * The commit guard AT THE ACT BOUNDARY — the runner half of #627 / #629.
 *
 * ── Why it has to be here
 *
 * `dryRun` and `readOnly` were enforced entirely in the cloud, on `action.name`: a string the MODEL
 * wrote ABOUT the element. This process is the one that actually clicks, and it clicks by `ref`
 * ({@link https://github.com/microsoft/playwright-mcp} `browser_click({ element, target })` — only
 * `target` locates; `element` is a human-readable description). So the guard tested a story about
 * the act while the act went somewhere else entirely, and the runner — the only party holding the
 * DOM, and therefore the only one that can KNOW whether a control submits — had never been told
 * that a run was a rehearsal at all: `grep -rn dryRun packages/browser-runner/src` returned eight
 * hits and every one of them was the orphaned-browser reaper's unrelated `--dry-run` flag.
 *
 * A nameless click had already submitted a real application during a run the owner asked to be a
 * test. The fix at the time made an EMPTY name a refusal, which left a WRONG name — a paraphrase,
 * an `aria-label` the model rewrote, a page in French — behaving exactly as before.
 *
 * ── What is a fact here and what is still a guess
 *
 * FACT (`read_only`): whether the targeted control submits a form, and whether that form is a POST.
 * Language-independent, label-independent, and not something the brain can talk its way past. A
 * GET form is a search — the read-only prompt explicitly allows finding things — so only POST is
 * refused. Enter and Space are checked against the FOCUSED element the same way.
 *
 * GUESS (both rehearsal modes): which of several POST submits on a multi-page ATS is the FINAL one.
 * Nothing in the DOM says so — "Save and Continue" on page 3 and "Submit application" on page 6 are
 * the same kind of control — and a rehearsal must be able to walk the whole form. So a rehearsal
 * still decides on a LABEL. What changed is whose label: the element's own accessible name, read
 * back out of the live DOM, instead of the model's claim about it, and a vocabulary that is not
 * English-only. That residual is recorded on the issue rather than papered over.
 */

/** Sent by the cloud with each guarded action. `labels` is a regex SOURCE, so a vocabulary fixed
 *  in the Worker reaches a runner built before the word existed — the published CLI upgrades on
 *  the field's schedule, not ours. */
export interface CommitGuardSpec {
	mode: "read_only" | "dry_run";
	labels?: string;
	flags?: string;
}

/** What the page says about the element the brain targeted. */
export interface ElementFacts {
	/** Clicking this control submits a form (native submit control inside a form). */
	submits: boolean;
	/** The form's method, lowercased. "get" is a query; "post" is a mutation. */
	method: string;
	/** The element's REAL accessible name, from the DOM. */
	name: string;
	tag: string;
	type: string;
}

/** What the page says about whatever currently has focus (for a keypress). */
export interface FocusFacts {
	inForm: boolean;
	method: string;
	tag: string;
	type: string;
	name: string;
}

/**
 * The FLOOR vocabulary, used only when the cloud sent none. It is deliberately the read-only
 * (widest) set: a runner that has been told "read_only" but not told the words must not fail open.
 * The authoritative list is `workers/api/src/lib/commit-guard.ts`, and `commit-guard.test.ts` there
 * asserts this file still parses as a regex, so a copy that rots is a red build rather than a
 * silent downgrade.
 */
export const FALLBACK_COMMIT_RE =
	/\b(confirm|accept|submit|send|post|publish|delete|remove|pay|purchase|buy|apply|approve|agree|save)\b|(?<![\p{L}\p{N}])(envoyer|soumettre|valider|absenden|abschicken|senden|einreichen|enviar|invia|inviare|verstuur|versturen|verzenden|indienen|skicka|wy[śs]lij|g[öo]nder|kirim|отправить)(?![\p{L}\p{N}])|提交|送出|确认|確認|送信|提出|제출|보내기|إرسال|تقديم/iu;

/** Compile the policy the cloud sent, falling back to the floor above. A malformed pattern must
 *  NOT disarm the guard — it falls back rather than throwing, because the caller is about to act. */
export function commitLabelRe(spec: CommitGuardSpec | undefined | null): RegExp {
	if (!spec?.labels) return FALLBACK_COMMIT_RE;
	try {
		return new RegExp(spec.labels, spec.flags || "iu");
	} catch {
		return FALLBACK_COMMIT_RE;
	}
}

/** Keys that submit a focused form. `NumpadEnter` submits identically and was matched by nothing. */
export const SUBMIT_KEY_RE = /^(enter|return|numpadenter)$/i;
/** Space activates the focused control, including a submit button. */
export const ACTIVATE_KEY_RE = /^(space|spacebar|\s)$/i;

/** The probe evaluated ON the targeted element. Kept as source text because it crosses into the
 *  page through the standard `browser_evaluate` tool, which takes a function expression. */
export const ELEMENT_PROBE_FN = `el => {
  var btn = (el.closest && el.closest('button,input,a,[role=button]')) || el;
  var tag = (btn.tagName || '').toLowerCase();
  var type = ((btn.getAttribute && btn.getAttribute('type')) || '').toLowerCase();
  var form = btn.form || (btn.closest && btn.closest('form')) || null;
  var submits = !!form && ((tag === 'button' && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image')));
  var name = (btn.getAttribute && btn.getAttribute('aria-label')) || btn.value || btn.innerText || btn.textContent || '';
  return { submits: submits, method: form ? ((form.getAttribute('method') || 'get').toLowerCase()) : '', tag: tag, type: type, name: String(name).replace(/\\s+/g, ' ').trim().slice(0, 160) };
}`;

/** The probe for a keypress: there is no ref, so it reads whatever has focus. */
export const FOCUS_PROBE_FN = `(() => {
  var el = document.activeElement;
  if (!el) return { inForm: false, method: '', tag: '', type: '', name: '' };
  var form = el.form || (el.closest && el.closest('form')) || null;
  var name = (el.getAttribute && el.getAttribute('aria-label')) || el.value || el.innerText || el.textContent || '';
  return { inForm: !!form, method: form ? ((form.getAttribute('method') || 'get').toLowerCase()) : '', tag: (el.tagName || '').toLowerCase(), type: ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase(), name: String(name).replace(/\\s+/g, ' ').trim().slice(0, 160) };
})()`;

/**
 * May this click reach the page? Returns the refusal to hand back to the brain, or null.
 *
 * `facts` is null when the element could not be probed (an evaluate that failed, a ref the page no
 * longer has). That is not treated as permission: in read-only it is refused outright, and in a
 * rehearsal it falls back to the claimed name, which is the behaviour that shipped.
 */
export function refuseClick(spec: CommitGuardSpec, facts: ElementFacts | null, claimedName: string | undefined, re: RegExp): string | null {
	const claimed = (claimedName ?? "").trim();
	const real = (facts?.name ?? "").trim();
	if (spec.mode === "read_only") {
		if (!facts) {
			return "BLOCKED by the runner — this agent is READ-ONLY and that element could not be read from the page, so the click cannot be shown to be safe. Re-read the snapshot and target an element from it.";
		}
		if (facts.submits && facts.method === "post") {
			return `BLOCKED by the runner — this agent is READ-ONLY and "${real || claimed || facts.tag}" submits a form (POST) on this page. That is a change, whatever the control is called. Report what you can already see with finish.`;
		}
	}
	const hit = [real, claimed].find((n) => n && re.test(n));
	if (!hit) return null;
	return spec.mode === "read_only"
		? `BLOCKED by the runner — this agent is READ-ONLY and can never perform "${hit}". Report what you can already see with finish.`
		: `BLOCKED by the runner — this is a REHEARSAL and "${hit}" commits. The page never received the click. Call finish now instead of retrying.`;
}

/**
 * May this keypress reach the page?
 *
 * Read-only only. A rehearsal's Enter is decided by the cloud loop, which holds the one piece of
 * state that makes the call — an Enter immediately after an arrow key is an autocomplete ACCEPT,
 * not a submit — and this process cannot tell a JS listbox that will swallow the key from a form
 * that will take it.
 */
export function refuseKey(spec: CommitGuardSpec, key: string | undefined, focus: FocusFacts | null): string | null {
	if (spec.mode !== "read_only") return null;
	const k = (key ?? "").trim();
	const submitKey = SUBMIT_KEY_RE.test(k);
	const activateKey = ACTIVATE_KEY_RE.test(k);
	if (!submitKey && !activateKey) return null;
	if (!focus) {
		return `BLOCKED by the runner — this agent is READ-ONLY and the focused element could not be read, so pressing ${k || "Enter"} cannot be shown to be safe.`;
	}
	if (submitKey && focus.inForm && focus.method === "post") {
		return `BLOCKED by the runner — this agent is READ-ONLY and pressing ${k} submits the form this field belongs to (POST). A search or filter that only reads (GET) is fine; this one writes. Report what you can already see with finish.`;
	}
	if (activateKey && (focus.tag === "button" || focus.type === "submit") && focus.method === "post") {
		return `BLOCKED by the runner — this agent is READ-ONLY and Space activates "${focus.name || "the focused button"}", which submits a form (POST).`;
	}
	return null;
}
