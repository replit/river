#!/usr/bin/env bash
# Compile the River P model and run every checker scenario.
#
# Requires the `p` CLI (P model checker) and the .NET SDK:
#   nix develop .#verification
#
# Usage: ./check.sh [schedules]   (default 10000)
set -euo pipefail
cd "$(dirname "$0")"

SCHEDULES="${1:-10000}"

p compile

# Scenarios that must be bug-free. Each runs under two search strategies:
# the default random scheduler and the feedback-mutation scheduler (which
# reaches the rarer transparent-reconnect and rehandshake interleavings —
# mutation testing showed some seeded bugs are only found by feedback).
GREEN_TESTS=(tcHappyPath tcDrops tcRestart tcByzantine tcPhantom tcRehandshake)

fail=0
for t in "${GREEN_TESTS[@]}"; do
  for strat in "" "--sch-feedback"; do
    echo "--- $t $strat"
    # shellcheck disable=SC2086
    # `p check` exits nonzero when it finds a bug; don't let set -e abort
    out="$(p check -tc "$t" -s "$SCHEDULES" $strat 2>&1 | grep -E '\.\. Found [0-9]+ bug' | tail -1 || true)"
    echo "    $out"
    if ! grep -q 'Found 0 bugs' <<<"$out"; then
      echo "    FAIL: $t found a bug (trace in PCheckerOutput/BugFinding/)"
      fail=1
    fi
  done
done

# Regression scenarios that must FIND a bug. If the checker stops finding
# them, the model lost the races that motivated the fixes.
echo "--- tcZeroStateDup (expects a bug: pre-isReconnect duplicate delivery)"
out="$(p check -tc tcZeroStateDup -s $((SCHEDULES * 2)) --sch-feedback 2>&1 | grep -E '\.\. Found [0-9]+ bug' | tail -1 || true)"
echo "    $out"
if grep -q 'Found 0 bugs' <<<"$out"; then
  echo "    FAIL: the zero-state duplicate-delivery regression no longer reproduces"
  fail=1
fi

echo "--- tcD7c0ec9Regression (expects a bug: pre-fix consumed-handle crash)"
out="$(p check -tc tcD7c0ec9Regression -s $((SCHEDULES * 4)) --sch-feedback 2>&1 | grep -E '\.\. Found [0-9]+ bug' | tail -1 || true)"
echo "    $out"
if grep -q 'Found 0 bugs' <<<"$out"; then
  echo "    FAIL: the d7c0ec9 regression no longer reproduces"
  fail=1
fi

# Inductive proof (PVerifier -> UCLID5 -> Z3; provided by the .#verification
# dev shell). Unlike the bounded scenarios above, this covers UNBOUNDED
# executions: the seq/ack sliding window PLUS sessions, server state loss,
# handshakes, and reconnection — proving the isReconnect guard makes
# duplicate delivery unreachable (removing the guard from the model makes
# the proof fail).
echo "--- SessionReconnect inductive proof"
proof_out="$(cd verified && rm -rf PGenerated && p compile -pf SessionReconnect.p -pn RiverSessionReconnect -md verification 2>&1 || true)"
echo "$proof_out" | grep -E '🎉|❌' | sed 's/^/    /'
if echo "$proof_out" | grep -q '❌'; then
  echo "    FAIL: inductive proof did not go through"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "MODEL CHECK FAILED"
  exit 1
fi
echo "MODEL CHECK PASSED"
