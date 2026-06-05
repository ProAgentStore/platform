/**
 * ProAgentStore host worker — serves marketing pages + console.
 * Pages are inlined from store/ at build time via build.js → pages.ts.
 */
import { homepage, aboutPage, getStartedPage, consolePage } from './pages.js';

const PAGES: Record<string, string> = {
  '/': homepage,
  '/about': aboutPage,
  '/about/': aboutPage,
  '/get-started': getStartedPage,
  '/get-started/': getStartedPage,
  '/console': consolePage,
  '/console/': consolePage,
};

const HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const page = PAGES[url.pathname];

    if (page) {
      return new Response(page, { headers: HEADERS });
    }

    if (url.pathname === '/index.html') {
      return Response.redirect(`${url.origin}/`, 301);
    }

    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  },
};
