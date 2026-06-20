import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "../..");
const source = resolve(repoRoot, "packages/browser-runner/dist");
const target = resolve(cliRoot, "dist/browser-runner");

await rm(target, { force: true, recursive: true });
await cp(source, target, { recursive: true });
