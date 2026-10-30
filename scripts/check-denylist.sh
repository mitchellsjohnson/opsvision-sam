#!/usr/bin/env bash
# Name guard: fail if any tracked file contains a denied term.
#
# Usage: scripts/check-denylist.sh [path...]
#
# Terms are newline-separated and come from $OPSVISION_DENYLIST (e.g. a CI
# secret) or, if that is unset/empty, the untracked file .denylist in the
# current directory. Matching is case-insensitive and fixed-string, over
# tracked files only (git grep). Binary files are skipped.
#
# Prints file:line:term for each match and exits 1 if any are found.
# Exits 0 (with a warning on stderr) if no list is configured.
set -u

terms=""
if [ -n "${OPSVISION_DENYLIST:-}" ]; then
  terms="$OPSVISION_DENYLIST"
elif [ -f .denylist ]; then
  terms="$(cat .denylist)"
fi

# Drop blank lines (an empty pattern would match everything) and CR characters.
terms="$(printf '%s\n' "$terms" | tr -d '\r' | sed '/^[[:space:]]*$/d')"

if [ -z "$terms" ]; then
  echo "check-denylist: no denylist configured (set OPSVISION_DENYLIST or create .denylist); skipping" >&2
  exit 0
fi

found=0
while IFS= read -r term; do
  [ -z "$term" ] && continue
  # -I skips binary files.
  matches="$(git grep -n -i -F -I -e "$term" -- "$@" 2>/dev/null)"
  if [ -n "$matches" ]; then
    found=1
    # Report file:line:term without echoing the surrounding content.
    printf '%s\n' "$matches" | awk -F: -v t="$term" '{ print $1 ":" $2 ":" t }'
  fi
done <<EOF
$terms
EOF

if [ "$found" -ne 0 ]; then
  echo "check-denylist: denied terms found in tracked files" >&2
  exit 1
fi
exit 0
