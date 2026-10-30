#!/usr/bin/env bash
# Test for scripts/check-denylist.sh. Run: bash scripts/check-denylist_test.sh
set -u

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-denylist.sh"
FAILED=0

fail() { echo "FAIL: $*"; FAILED=1; }
pass() { echo "PASS: $*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP" || exit 1
git init -q .
git config user.email test@example.com
git config user.name test

# Case 1: a tracked file containing a denied term -> exit 1, output has the term.
echo "Welcome to Contoso Widgets" > bad.txt
git add bad.txt
out="$(OPSVISION_DENYLIST=contoso bash "$SCRIPT" 2>/dev/null)"
rc=$?
if [ "$rc" -eq 1 ]; then pass "match exits 1"; else fail "match: expected exit 1, got $rc"; fi
if printf '%s' "$out" | grep -qi 'contoso'; then pass "output names term"; else fail "output missing term: $out"; fi
if printf '%s' "$out" | grep -q '^bad.txt:1:'; then pass "output has file:line"; else fail "output missing file:line: $out"; fi

# Case 2: only clean files -> exit 0.
git rm -q -f --cached bad.txt
rm -f bad.txt
echo "nothing to see here" > clean.txt
git add clean.txt
OPSVISION_DENYLIST=contoso bash "$SCRIPT" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then pass "clean exits 0"; else fail "clean: expected exit 0, got $rc"; fi

# Case 3: no list configured -> exit 0 with warning on stderr.
err="$(env -u OPSVISION_DENYLIST bash "$SCRIPT" 2>&1 >/dev/null)"
rc=$?
if [ "$rc" -eq 0 ]; then pass "unset exits 0"; else fail "unset: expected exit 0, got $rc"; fi
if printf '%s' "$err" | grep -q 'no denylist configured'; then pass "unset warns"; else fail "unset: missing warning: $err"; fi

exit "$FAILED"
