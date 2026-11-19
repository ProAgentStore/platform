/**
 * The shell halves of the git shim that guard a SHARED checkout (#1489) — kept apart from `git-guard.ts` so the
 * stash guard (#1021) it extends stays readable. Both are text spliced into the generated POSIX `sh` script; they are
 * `String.raw`, so every backslash below is for the shell. A literal shell `${…}` is written `$@{…}` and rewritten on the
 * way out, because `String.raw` would otherwise treat it as a template substitution.
 *
 * See `git-guard.ts` for what is refused, what is deliberately left alone, and the gaps.
 */

const shell = (text: string): string => text.replace(/\$@\{/g, "${");

/**
 * Classifies the subcommand's own arguments (its flags before `--`, and whether any pathspec names the whole tree) and
 * defines `audit`, the one-line-per-mutation evidence record. Runs before any refusal so a refusal is recorded too.
 * Needs `sub`, `subidx` and `AUDIT` from the script's argument parse.
 */
export const AUDIT_AND_CLASSIFY: string = shell(String.raw`# The whole command line, taken here because inside a function "$@" is the function's own arguments.
argv_all="$*"
# The subcommand's own flags (before "--") and whether a pathspec names the whole tree.
flags=" "; whole=0; dd=0; i=0
if [ -n "$sub" ]; then
  for a in "$@"; do
    i=$((i + 1))
    [ "$i" -le "$subidx" ] && continue
    if [ "$dd" = 0 ]; then
      case "$a" in
        --) dd=1; continue ;;
        -*) flags="$flags$a "; continue ;;
      esac
    fi
    case "$a" in .|./|:/|:/.|":(top)"|":(top)."|":(top)/") whole=1 ;; esac
  done
fi
has_flag() { case "$flags" in *" $1 "*) return 0 ;; esac; return 1; }
# A short-flag cluster containing the letter: -fdn has n. Long flags are matched whole by has_flag.
short_has() { for f in $flags; do case "$f" in --*) : ;; -*"$1"*) return 0 ;; esac; done; return 1; }

# One best-effort line per mutating subcommand. It must never be the reason git does not run.
audit() {
  case "$sub" in reset|clean|checkout|restore|switch|stash|rebase|merge|cherry-pick|revert|am|pull|apply) ;; *) return 0 ;; esac
  log="$@{PAGS_GIT_AUDIT_LOG:-$AUDIT}"
  {
    mkdir -p "$(dirname "$log")"
    if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1048576 ]; then mv -f "$log" "$log.1"; fi
    printf '%s\t%s\t%s\tsession=%s\tpid=%s\tppid=%s\tcwd=%s\t%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$sub" "$@{PAGS_SESSION_ID:-unknown}" "$$" "$PPID" \
      "$(pwd | tr '\t\n\r' '   ')" "$(printf '%s' "$argv_all" | tr '\t\n\r' '   ')"
  } >> "$log" 2>/dev/null || true
}
`);

/** The repo-wide discards refused before git runs. Needs `refuse_discard`'s marker and exit, passed in. */
export function destructiveChecks(marker: string, exitCode: number): string {
	return shell(`refuse_discard() {
  audit refused
  echo "${marker}: 'git $sub' $1 In a shared checkout that discards other people's uncommitted work too, tracked or untracked." >&2
  echo "Discard only your own files by name (git checkout HEAD -- <file>), or do bulk work in an isolated 'git worktree add --detach' checkout nobody else shares." >&2
  exit ${exitCode}
}
case "$sub" in
  reset) has_flag --hard && refuse_discard "with --hard rewrites every tracked file in the working tree." ;;
  clean) { has_flag -n || has_flag --dry-run || short_has n; } || refuse_discard "deletes untracked files and directories; only a dry run (-n) is allowed." ;;
  checkout|switch)
    { has_flag --force || has_flag --discard-changes || short_has f; } && refuse_discard "with --force throws away local changes to switch."
    [ "$sub" = checkout ] && [ "$whole" = 1 ] && refuse_discard "of the whole tree overwrites every modified file."
    ;;
  restore)
    if [ "$whole" = 1 ] && { ! has_flag --staged || has_flag --worktree || has_flag -W; }; then
      refuse_discard "of the whole tree overwrites every modified file."
    fi
    ;;
esac
`);
}
