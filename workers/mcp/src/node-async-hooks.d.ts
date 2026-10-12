// The one Node API this worker uses (#1038, `call-context.ts`). Workers provide it under
// `nodejs_compat`; the project type-checks against `@cloudflare/workers-types` only, so the
// declaration lives here rather than pulling all of `@types/node` in beside the Workers globals.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		run<R>(store: T, fn: () => R): R;
		getStore(): T | undefined;
	}
}
