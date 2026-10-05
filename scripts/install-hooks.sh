#!/usr/bin/env bash
# Opt in to the local git hooks (#902): bash scripts/install-hooks.sh
# Opt out again:                         bash scripts/install-hooks.sh --uninstall
#
# A fast local trip-wire, NOT a safety gate — CI enforces every check independently. Never
# activated by a clone: it only sets `core.hooksPath` for THIS checkout, and it will not replace a
# hooksPath you set yourself unless you pass --force.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CURRENT="$(git config --get core.hooksPath || true)"

if [[ "${1:-}" == "--uninstall" ]]; then
	if [[ "$CURRENT" == ".githooks" ]]; then
		git config --unset core.hooksPath
		echo "Hooks deactivated for this checkout."
	else
		echo "Nothing to undo: core.hooksPath is '${CURRENT:-unset}', not .githooks."
	fi
	exit 0
fi

if [[ -n "$CURRENT" && "$CURRENT" != ".githooks" && "${1:-}" != "--force" ]]; then
	echo "core.hooksPath is already '$CURRENT' for this checkout — leaving it alone." >&2
	echo "Rerun with --force to switch it to .githooks." >&2
	exit 1
fi

chmod +x .githooks/pre-commit .githooks/pre-push
git config core.hooksPath .githooks
echo "Activated pre-commit and pre-push hooks from $ROOT/.githooks (undo: bash scripts/install-hooks.sh --uninstall)."
