# Contributing

## Filing an issue

### Citing code in issue bodies

When you cite a source location, include **both the line's text and its coordinate**. A quoted string is self-verifying — a later reader can `grep` for it and either find it or learn immediately that it moved. A bare coordinate fails silently: it points at whatever happens to be at that line today, which may be unrelated code.

**Pattern that survives drift:**

> `recordCodingFailure` is called from the workflow's catch at `workers/api/src/workflows/coding-session.ts:733`

**Pattern that rots silently:**

> the call is at `coding-session.ts:705`

The text form is the claim. The coordinate is a locator — useful when found, harmless when stale.

### Asserting counts and grep results

Stamp asserted measurements with the command and the date:

> `grep -rn "z.number()" workers/api/src` returned **32** on 2026-08-18.

A bare count with no command or date cannot be re-verified; a reader running the check later cannot tell whether the number changed or whether they ran the wrong query.

### Branch references

Branch names are deleted after merge. If you reference a branch (`feat/some-branch`), also include what survived it — a commit SHA, a closed issue, or the feature that landed.

---

## Local git hooks

Active in every checkout with no manual step: `pnpm install` runs husky through the root `prepare`
script, which points this checkout's `core.hooksPath` at `.husky/_` (#1103). The hooks themselves
are `.husky/pre-commit` and `.husky/pre-push`, each one line that runs our script. To skip
activation (a packaging job, say), install with `HUSKY=0`.

- **pre-commit** (about a second): refuses whitespace errors in what is staged. It runs the
  file-size ratchet (#302) over the STAGED content (`check-file-size.mjs --staged`), with CI's
  message: split the file, or raise its pin with a reason, in the same commit. It refuses a
  checked file that also has unstaged edits, so the check sees exactly what you commit. Then it
  runs CI's Biome lint (`--error-on-warnings`) over the staged files CI lints.
- **pre-push** (typically 30-60 s): runs CI's guard scripts with CI's arguments, plus
  `docs:drift`. Then it typechecks each workspace project the push touches, as CI does: its
  `typecheck` script, plus `tsconfig.test.json` where one exists. Last, it runs
  `vitest related` over the pushed source files. That is the unit tests importing them, not the
  full suite.

These hooks are a trip-wire, never a gate. CI enforces every one of these checks, and the full
suite, on every push whether or not the hooks ran. So `git commit --no-verify` /
`git push --no-verify` bypass only the early warning; say so if you use them. Run either check
by hand with `node scripts/pre-commit.mjs` or `node scripts/pre-push.mjs` (the latter compares
against `origin/main`). What each hook runs is decided in `scripts/lib/hook-plan.mjs`, and its
test fails if the guard list stops matching CI's (#902).

## Tests that lock an invariant

Test the behaviour, not the spelling: call the code and assert what it does, or — for a genuine
architectural rule such as "this layer must not import that one" — use a structure-aware check
that survives a file move. Never assert that a hard-coded source file contains particular text.
Name the invariant the test protects. The full standard, and the remaining text guards still to
convert, are in [`docs/testing-standards.md`](docs/testing-standards.md) (#915).

## Docs citations (`docs/` and `platform-docs/`)

The CI guard `check-doc-citations.mjs` enforces that every backtick-quoted `file:N` reference in `docs/` and `platform-docs/` resolves to exactly one file in the repo tree. A cited path that matches zero files, or that matches more than one (ambiguous), fails the build.

**What is checked:** path resolution only — whether the file exists and is unambiguous.

**What is NOT checked:** whether the line number is still correct. Apply the same rule as for issue bodies: quote the relevant text alongside the coordinate so a reader can grep for it.

```markdown
<!-- Good: full path, text quoted -->
`coding/headless.ts:291` (`resumedConversation` getter)

<!-- Good: unique suffix, text named -->
`lib/connectors/manifest.ts:239` (`AUTH_TYPES`)

<!-- Bad: ambiguous bare name -->
`manifest.ts:216`

<!-- Bad: full path but no quoted text — line drift is invisible -->
`coding/headless.ts:260`
```

If a file name is shared across packages (e.g. `manifest.ts`), use a longer prefix that makes it unique (`lib/connectors/manifest.ts`). Check uniqueness with:

```bash
git ls-files | grep -E '(^|/)manifest\.ts$'
```
