#!/usr/bin/env node
/**
 * Generates static detail pages for each agent in registry.json.
 * Output: store/dist/agents/{id}/index.html
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
	fs.readFileSync(path.join(__dirname, "registry.json"), "utf-8"),
);
const distDir = path.join(__dirname, "dist");

function generateDetailPage(agent) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${agent.name} — ProAgentStore</title>
  <meta name="description" content="${agent.description} Server-powered AI agent. $9/mo.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${agent.name} — ProAgentStore">
  <meta property="og:description" content="${agent.description}">
  <meta property="og:url" content="https://proagentstore.online/agents/${agent.id}/">
  <link rel="canonical" href="https://proagentstore.online/agents/${agent.id}/">
  <script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: agent.name,
		description: agent.description,
		applicationCategory: agent.category || "AI",
		operatingSystem: "Web",
		url: `https://proagentstore.online/agents/${agent.id}/`,
		offers: { "@type": "Offer", price: "9", priceCurrency: "USD" },
		isPartOf: { "@id": "https://proagentstore.online/#website" },
	})}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--font-body:'Manrope',system-ui,sans-serif;--font-display:'Fraunces',Georgia,serif;--paper:#0a0a0a;--panel:#171717;--ink:#fafafa;--muted:#a3a3a3;--muted-soft:#737373;--accent:#7c3aed;--accent-hover:#6d28d9;--free:#3b82f6;--line:#262626;--line-strong:#404040;--shadow:0 1px 3px rgba(0,0,0,0.3);--radius:0.75rem}
    body{font-family:var(--font-body);background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased;min-height:100vh}
    .container{max-width:960px;margin:0 auto;padding:0 1.5rem}
    a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
    header{border-bottom:1px solid var(--line)}
    header .c{max-width:1200px;margin:0 auto;padding:0.75rem 1.5rem;display:flex;align-items:center;gap:1.25rem}
    .brand{display:flex;align-items:center;gap:0.6rem;text-decoration:none;color:var(--ink)}
    .brand-mark{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent),#6366f1);display:flex;align-items:center;justify-content:center;font-size:1.1rem}
    .brand-name{font-family:var(--font-display);font-size:1.15rem;font-weight:700}
    nav{display:flex;gap:1.25rem;font-size:0.88rem;font-weight:600;margin-left:auto}
    nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--ink)}
    nav a.free{color:var(--free)}
    .back{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.88rem;color:var(--muted);margin:1.25rem 0 1rem;text-decoration:none}
    .back:hover{color:var(--ink)}
    .hero{display:flex;gap:1rem;align-items:start;margin-bottom:1.5rem}
    .hero-icon{width:64px;height:64px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:2rem;flex-shrink:0}
    .hero h1{font-family:var(--font-display);font-size:1.75rem;font-weight:700;line-height:1.2}
    .hero .cat{display:inline-block;font-size:0.78rem;padding:0.15rem 0.6rem;border-radius:999px;background:rgba(124,58,237,0.15);color:#a78bfa;margin-top:0.25rem;font-weight:500}
    .hero .dev{font-size:0.82rem;color:var(--muted);margin-top:0.3rem}
    .desc{color:var(--muted);line-height:1.7;margin-bottom:1.25rem;font-size:0.95rem}
    .infra{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem;margin:1.5rem 0}
    .infra-item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0.85rem 1rem}
    .infra-item h4{font-size:0.85rem;font-weight:600;margin-bottom:0.15rem}
    .infra-item p{font-size:0.78rem;color:var(--muted);margin:0}
    .cta{display:inline-flex;align-items:center;gap:0.5rem;background:var(--accent);color:#fff;padding:0.65rem 1.25rem;border-radius:10px;font-size:0.9rem;font-weight:600;text-decoration:none;margin-top:1rem;transition:background 0.15s}
    .cta:hover{background:var(--accent-hover);text-decoration:none}
    pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem;font-family:'SF Mono',monospace;font-size:0.82rem;overflow-x:auto;margin:1rem 0;color:#a78bfa}
    footer{border-top:1px solid var(--line);padding:2rem 0;text-align:center;font-size:0.8rem;color:var(--muted-soft);margin-top:3rem}
  </style>
</head>
<body>
  <header>
    <div class="c">
      <a href="/" class="brand"><span class="brand-mark">&#9889;</span><span class="brand-name">ProAgentStore</span></a>
      <nav>
        <a href="/">Agents</a>
        <a href="/about/">About</a>
        <a href="/get-started/">Get Started</a>
        <a href="https://github.com/ProAgentStore">GitHub</a>
        <a href="https://freeagentstore.online" class="free">Free</a>
      </nav>
    </div>
  </header>
  <main class="container">
    <a href="/" class="back">&larr; All agents</a>
    <div class="hero">
      <div class="hero-icon" style="background:${agent.iconBg || "#7c3aed"}">${agent.icon || "&#9889;"}</div>
      <div>
        <h1>${agent.name}</h1>
        <span class="cat">${agent.category || "ai"}</span>
        <div class="dev">by ${agent.developer || "ProAgentStore"}</div>
      </div>
    </div>
    <p class="desc">${agent.description}</p>
    <div class="infra">
      ${agent.usesAi !== false ? `<div class="infra-item"><h4>Workers AI</h4><p>${agent.model || "Server-side inference"}</p></div>` : ""}
      ${agent.usesDb !== false ? '<div class="infra-item"><h4>D1 Database</h4><p>Persistent state</p></div>' : ""}
      ${agent.usesStorage ? '<div class="infra-item"><h4>R2 Storage</h4><p>File storage + CDN</p></div>' : ""}
      ${agent.usesCron ? `<div class="infra-item"><h4>Cron</h4><p>${agent.cronSchedule || "Scheduled execution"}</p></div>` : ""}
      ${agent.usesApi !== false ? '<div class="infra-item"><h4>API</h4><p>REST endpoint</p></div>' : ""}
    </div>
    ${agent.apiExample ? `<h3 style="font-size:1rem;margin-top:1.5rem">API usage</h3><pre>${agent.apiExample}</pre>` : ""}
    <a href="${agent.agentUrl || "/"}" class="cta">Open Agent</a>
    ${agent.repo ? `<p style="margin-top:1rem;font-size:0.85rem;color:var(--muted)">Source: <a href="https://github.com/${agent.repo}">${agent.repo}</a></p>` : ""}
  </main>
  <footer>
    <a href="/">Agents</a> &middot; <a href="/about/">About</a> &middot; <a href="/get-started/">Get Started</a> &middot; <a href="https://github.com/ProAgentStore">GitHub</a> &middot; <a href="https://freeagentstore.online" style="color:#3b82f6">Free</a>
  </footer>
</body>
</html>`;
}

// Copy static pages to dist
function copyStaticPages() {
	for (const page of ["about", "get-started"]) {
		const src = path.join(__dirname, page, "index.html");
		if (fs.existsSync(src)) {
			const dest = path.join(distDir, page);
			fs.mkdirSync(dest, { recursive: true });
			fs.copyFileSync(src, path.join(dest, "index.html"));
			console.log(`  ${page}/index.html`);
		}
	}
}

// Generate agent detail pages
function buildAgentPages() {
	for (const agent of registry.agents) {
		const dir = path.join(distDir, "agents", agent.id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "index.html"), generateDetailPage(agent));
		console.log(`  agents/${agent.id}/index.html`);
	}
}

console.log("Building ProAgentStore detail pages...");
fs.mkdirSync(distDir, { recursive: true });
copyStaticPages();
buildAgentPages();
console.log(
	`Done. ${registry.agents.length} agent pages + static pages built.`,
);
