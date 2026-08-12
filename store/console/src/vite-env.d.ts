/// <reference types="vite/client" />

/**
 * The commit this bundle was built from, replaced at build time by `define` in vite.config.ts
 * (#539). `dev` when built outside CI. Reported on every client error row so a log entry says
 * which JavaScript produced it — see `setClientBuild` in @proagentstore/sdk/client.
 */
declare const __BUILD__: string;
