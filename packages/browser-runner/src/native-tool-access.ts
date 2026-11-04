import type { createConnection } from "@playwright/mcp";
type ToolCapability = NonNullable<NonNullable<Parameters<typeof createConnection>[0]>["capabilities"]>[number];

/** Every capability declared by the installed @playwright/mcp version. Core subgroups remain explicit. */
const capabilities = {
	config: true, core: true, "core-navigation": true, "core-tabs": true, "core-input": true, "core-install": true,
	network: true, pdf: true, storage: true, testing: true, vision: true, devtools: true,
} satisfies Record<ToolCapability, true>;
export const FULL_PLAYWRIGHT_CAPABILITIES = Object.keys(capabilities) as ToolCapability[];

export function unsafeNativeTool(name: string): boolean {
	return name === "browser_evaluate" || name === "browser_run_code" || name === "browser_run_code_unsafe";
}
