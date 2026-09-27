cd /Users/serge/.config/proagentstore/browser-runner/repos/repo_2b2657fb-31e5-48a4-99f3-147fffde0925; python3 - <<'EOF'
p='workers/api/src/lib/repo-write-scope.ts'; s=open(p).read()
old='''/** The segments that perform a REMOTE write — the same commands the runner classifies as one. */
const REMOTE_WRITE_SEGMENT = /\\bgit\\s+push\\b|\\bgh\\s+pr\\s+(?:create|merge)\\b|\\bgh\\s+release\\s+create\\b|\\bgh\\s+repo\\s+delete\\b/;'''
assert old in s
p='workers/api/src/lib/repo-write-scope.test.ts'; s=open(p).read()
block='''
		for (const command of [
			'git commit -m "see https://mcp.proappstore.online/mcp/apps/crm" && git push origin main',
			"gh pr merge 12 --squash --subject 'from https://github.com/other/repo' --body=https://github.com/other/repo/pull/3",
		]) {
		const cases: Array<[string, string]> = [
			["git push git@github-personal:other-org/other-repo.git main", "other-org/other-repo"],
			["git push origin main && gh api repos/other-org/other-repo/pulls -X POST -f title=x", "other-org/other-repo"],
		];
'''
open(p,'w').write(s)
EOF
npx vitest run workers/api/src/lib/repo-write-scope.test.ts 2>&1 | grep -E "✓|×|→|Tests " | head -40
