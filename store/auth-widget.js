/**
 * ProAgentStore shared auth widget.
 * Include on any page to show sign-in state in the nav.
 *
 * Usage: <script src="/auth-widget.js" defer></script>
 *
 * Looks for a <nav> in <header> and appends user info or "Sign in" link.
 * Reads session token from localStorage ('pags:session').
 */
(() => {
	const API = "https://api.proagentstore.online";
	const SESSION_KEY = "pags:session";
	const token = localStorage.getItem(SESSION_KEY);

	const nav = document.querySelector("header nav");
	if (!nav) return;

	// Create container for auth UI
	const authEl = document.createElement("span");
	authEl.style.cssText =
		"display:inline-flex;align-items:center;gap:0.5rem;margin-left:0.25rem";

	if (!token) {
		// Not signed in — show sign-in link
		const link = document.createElement("a");
		link.href = "/console/";
		link.textContent = "Sign in";
		link.style.cssText =
			"color:#a3a3a3;text-decoration:none;font-size:0.88rem;font-weight:600";
		link.onmouseenter = () => (link.style.color = "#fafafa");
		link.onmouseleave = () => (link.style.color = "#a3a3a3");
		authEl.appendChild(link);
		nav.appendChild(authEl);
		return;
	}

	// Have token — verify and show user
	fetch(`${API}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
		.then((r) => (r.ok ? r.json() : null))
		.then((user) => {
			if (!user?.login) {
				// Invalid token — clear and show sign-in
				localStorage.removeItem(SESSION_KEY);
				const link = document.createElement("a");
				link.href = "/console/";
				link.textContent = "Sign in";
				link.style.cssText =
					"color:#a3a3a3;text-decoration:none;font-size:0.88rem;font-weight:600";
				authEl.appendChild(link);
				nav.appendChild(authEl);
				return;
			}

			// Valid — show avatar + link to console profile
			const wrapper = document.createElement("a");
			wrapper.href = "/console/";
			wrapper.style.cssText =
				"display:inline-flex;align-items:center;gap:0.4rem;text-decoration:none";

			const avatar = document.createElement("img");
			avatar.src = user.avatar || "";
			avatar.alt = user.login;
			avatar.style.cssText =
				"width:26px;height:26px;border-radius:50%;border:2px solid #262626";

			const name = document.createElement("span");
			name.textContent = user.login;
			name.style.cssText = "font-size:0.82rem;color:#a3a3a3;font-weight:500";

			wrapper.appendChild(avatar);
			wrapper.appendChild(name);
			authEl.appendChild(wrapper);
			nav.appendChild(authEl);
		})
		.catch(() => {
			// Network error — show nothing (fail silently)
		});
})();
