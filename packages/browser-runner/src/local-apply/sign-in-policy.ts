/** Native facts for a sign-in action. Page-wide password fields never authorize a different form. */
export interface SignInControlFacts {
	origin: string;
	visible: boolean;
	safeDestination: boolean;
	credential: "username" | "password" | "code" | null;
	sessionControl: boolean;
}

export const SIGN_IN_CONTROL_PROBE_FN = `(el) => {
	const visible = (node) => !!node && !node.disabled && !node.closest('[hidden], [inert], [aria-hidden="true"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
	const credential = (node) => {
		if (!visible(node) || !['INPUT', 'TEXTAREA'].includes(node.tagName)) return null;
		if (node.type === 'password') return 'password';
		const info = [node.name, node.id, node.getAttribute('autocomplete'), node.getAttribute('aria-label'), ...(node.labels || [])].map(x => typeof x === 'string' ? x : x?.textContent || '').join(' ');
		if (/one-time-code|passcode|verification|security.?code|sign.?in.?code|\\botp\\b/i.test(info) || /^code(?:\\s+code)*$/i.test(info.trim())) return 'code';
		if (node.type === 'email' || /username|user.name|email|e-mail/i.test(info)) return 'username';
		return null;
	};
	const scope = el.form || el.closest('form, [role="dialog"]');
	const name = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim();
	const explicit = /^(sign ?in|log ?in|verify( code)?|email me( a)?( sign.?in)? code|text me( a)? code|get( a| the)? code|resend( code)?)$/i.test(name);
	const advance = /^(continue|next)$/i.test(name);
	const genericCommit = /^(confirm|submit|send)$/i.test(name);
	const fields = scope ? [...scope.querySelectorAll('input, textarea')].filter(visible) : [];
	const hasCredential = fields.some(node => credential(node));
	const hasPasswordOrCode = fields.some(node => ['password', 'code'].includes(credential(node)));
	const application = fields.some(node => node.type === 'file' || node.tagName === 'TEXTAREA') || /application|resume|cover.?letter|employment/i.test(name);
	const action = el.getAttribute('formaction') || scope?.getAttribute('action');
	let sameOrigin = true;
	let authDestination = false;
	try {
		const destination = new URL(action || location.href, location.href);
		sameOrigin = destination.origin === location.origin;
		authDestination = /\\/(login|log-in|signin|sign-in|auth|authenticate|verify|oauth2?|authorize)(\\/|$)/i.test(destination.pathname);
	} catch { sameOrigin = false; }
	return { origin: location.origin, visible: visible(el), safeDestination: sameOrigin, credential: credential(el), sessionControl: visible(el) && sameOrigin && !!scope && hasCredential && !application && (explicit || (authDestination && (advance || (genericCommit && hasPasswordOrCode)))) };
}`;

/** Visible credential walls, including passwordless / OTP forms on ordinary application URLs. */
export const SIGN_IN_PAGE_PROBE_FN = `() => {
	const visible = (node) => !node.disabled && !node.closest('[hidden], [inert], [aria-hidden="true"]') && node.getClientRects().length > 0 && node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
	return [...document.querySelectorAll('input')].filter(visible).some(node => {
		if (node.type === 'password') return true;
		const info = [node.name, node.id, node.getAttribute('autocomplete'), node.getAttribute('aria-label'), ...(node.labels || [])].map(x => typeof x === 'string' ? x : x?.textContent || '').join(' ');
		if (/one-time-code|passcode|verification|security.?code|sign.?in.?code|\\botp\\b/i.test(info)) return true;
		if (node.type !== 'email' && !/username|user.name|email|e-mail/i.test(info)) return false;
		const scope = node.form || node.closest('form, [role="dialog"]');
		return !!scope && [...scope.querySelectorAll('button, input[type="submit"]')].some(button => visible(button) && /^(sign ?in|log ?in|email me( a)?( sign.?in)? code|text me( a)? code|get( a| the)? code)$/i.test((button.getAttribute('aria-label') || button.textContent || button.value || '').trim()));
	});
}`;

/** Exact origins, not a registrable-domain approximation, bind credential injection. */
export function signInOrigin(url: string): string | null {
	try {
		const u = new URL(url);
		return (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) && !u.username && !u.password ? u.origin : null;
	} catch {
		return null;
	}
}
