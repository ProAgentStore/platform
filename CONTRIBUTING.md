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
