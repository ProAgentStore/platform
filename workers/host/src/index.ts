/**
 * ProAgentStore Host Worker — placeholder landing page.
 * Will be expanded in Phase 3 with full agent hosting.
 */

const LANDING = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ProAgentStore</title>
<meta name="description" content="Server-powered AI agents. Coming soon.">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Manrope',system-ui,sans-serif;background:#0a0a0a;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem}
h1{font-size:2rem;margin-bottom:0.5rem}
h1 span{color:#7c3aed}
p{color:#a3a3a3;max-width:400px;line-height:1.6}
a{color:#7c3aed;text-decoration:none}
</style>
</head>
<body>
<div>
<h1>Pro<span>Agent</span>Store</h1>
<p>Server-powered AI agents. Coming soon.</p>
<p style="margin-top:1rem"><a href="https://freeagentstore.online">Start free →</a></p>
</div>
</body>
</html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response(LANDING, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    });
  },
};
