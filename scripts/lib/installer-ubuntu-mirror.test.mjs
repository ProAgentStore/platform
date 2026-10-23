import { describe, expect, it } from "vitest";
import { officialUbuntuMirror, useHostedUbuntuArchive } from "./installer-ubuntu-mirror.mjs";

describe("hosted Ubuntu installer mirror fallback (#1333)", () => {
	it("changes only the matching Azure Ubuntu archive, preserving suites, components, keys and other hosts", () => {
		const source = '# http://azure.archive.ubuntu.com/ubuntu\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nhttps://packages.microsoft.com/ubuntu/24.04/prod\nhttps://azure.archive.ubuntu.com.evil.example/ubuntu\nhttp://azure.archive.ubuntu.com/other\n';
		expect(officialUbuntuMirror(source)).toBe(source.replace('URIs: http://azure.archive.ubuntu.com/ubuntu/', 'URIs: https://archive.ubuntu.com/ubuntu/'));
	});
	it("never reads or writes configuration on local, non-Linux or self-hosted machines", async () => {
		for (const options of [{ platform: "darwin", env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" } }, { platform: "linux", env: {} }, { platform: "linux", env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" } }]) {
			expect(await useHostedUbuntuArchive({ ...options, read: () => { throw new Error("must not read"); }, write: () => { throw new Error("must not write"); } })).toEqual([]);
		}
	});
	it("updates only changed existing mirror files on the hosted VM and is idempotent", async () => {
		const files = new Map([["/etc/apt/apt-mirrors.txt", "http://azure.archive.ubuntu.com/ubuntu/\n"], ["/etc/apt/sources.list.d/ubuntu.sources", "URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\n"]]);
		const writes = [];
		const options = { platform: "linux", env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, read: (file) => files.get(file), write: (file, text) => { writes.push(file); files.set(file, text); }, log: () => {} };
		expect(await useHostedUbuntuArchive(options)).toEqual(["/etc/apt/apt-mirrors.txt"]);
		expect(files.get("/etc/apt/apt-mirrors.txt")).toBe("https://archive.ubuntu.com/ubuntu/\n");
		expect(await useHostedUbuntuArchive(options)).toEqual([]);
		expect(writes).toHaveLength(1);
	});
});
