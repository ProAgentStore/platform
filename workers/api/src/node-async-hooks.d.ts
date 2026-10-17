// The one Node API this worker uses (#1135, `lib/request-context.ts`). Workers provide it under
// `nodejs_compat`; the project type-checks against `@cloudflare/workers-types` only, so the
// declaration lives here rather than pulling all of `@types/node` in beside the Workers globals.
// A copy of `workers/mcp/src/node-async-hooks.d.ts` — the two Workers import nothing from each other.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		run<R>(store: T, fn: () => R): R;
		getStore(): T | undefined;
	}
}
