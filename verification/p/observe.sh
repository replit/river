#!/usr/bin/env bash
# Runtime conformance: run the hegel property-based suite with execution
# tracing, then check the traces against the P model's invariants with
# PObserve (compiled from the same spec language as the model checker).
#
# Requires the verification dev shell:  nix develop .#verification
# (provides `p`, `pobserve` + POBSERVE_HOME, and a JDK; the trace tap in
# testUtil/fixtures/trace.ts activates via RIVER_TRACE_DIR)
#
# Usage: ./observe.sh [trace-dir]
#   With no argument, runs the property suite to produce fresh traces.
#   With an argument, checks an existing trace directory.
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
TRACES="${1:-}"
if [ -n "$TRACES" ]; then
  TRACES="$(cd "$OLDPWD" 2>/dev/null && cd "$(dirname "$TRACES")" && pwd)/$(basename "$TRACES")" || TRACES="$1"
fi

# 1. compile the trace specs to Java monitors, then the Kotlin parser
p compile -pf PObs/RiverTraceSpecs.p -pn RiverTrace -md pobserve -o PObs/PGenerated
CP="$(cat "$POBSERVE_HOME/share/java/classpath.txt")"
rm -rf PObs/build && mkdir -p PObs/build
javac -cp "$CP" -d PObs/build PObs/PGenerated/PObserve/*.java
jar cf PObs/river-trace.jar -C PObs/build .
# -include-runtime bundles the Kotlin stdlib so the PObserve CLI's jar
# classloader can resolve it alongside the parser
kotlinc -cp "$CP:PObs/build" PObs/parser/RiverTraceParser.kt \
  -include-runtime -d PObs/river-parser.jar 2> >(grep -v '^warning:' >&2 || true)

# 2. produce traces from the real implementation (unless given a directory)
if [ -z "$TRACES" ]; then
  TRACES="$PWD/PObs/traces"
  rm -rf "$TRACES"
  echo "--- running the property suite with tracing (RIVER_TRACE_DIR)"
  (cd "$REPO_ROOT" && RIVER_TRACE_DIR="$TRACES" npx vitest run \
    __tests__/properties/session.property.test.ts \
    __tests__/properties/streams.property.test.ts)
fi
echo "--- traces: $(ls "$TRACES" | wc -l) files, $(cat "$TRACES"/* | wc -l) records"

# 3. check every spec (each partitions the trace stream differently)
declare -A MODES=(
  [AcceptedSeqContiguous]=session
  [EncodedSeqDense]=side
  [SessionStateConformance]=machine
  [StreamFlagDiscipline]=stream
  [NoInvariantViolations]=global
)

fail=0
for spec in "${!MODES[@]}"; do
  out="PObs/out/$spec"
  rm -rf "$out" && mkdir -p "$out"
  pobserve --jars PObs/river-trace.jar PObs/river-parser.jar --spec "$spec" \
    --parser RiverTraceParser --parserConfiguration "${MODES[$spec]}" \
    -l "$TRACES" -o "$out" > "$out/stdout.log" 2>&1 || true
  summary="$(awk '/Total Events Read/{getline; getline; print; exit}' "$out/PObserveMetrics.txt" 2>/dev/null | tr -s ' ' || true)"
  echo "--- $spec (${MODES[$spec]}): read/verified/keys/partitions: ${summary:-<no metrics>}"
  violations=$(find "$out" -name 'replayEvents_*' 2>/dev/null | wc -l || true)
  parser_errors=$(find "$out" -name 'ParserError*' -size +0 2>/dev/null | wc -l || true)
  if [ "$violations" -gt 0 ]; then
    echo "    CONFORMANCE VIOLATION(S): $violations partition(s), see $out/replayEvents_*"
    grep -m1 -h 'errorMessage=' "$out"/replayEvents_* | sed 's/^/    /'
    fail=1
  fi
  if [ "$parser_errors" -gt 0 ]; then
    echo "    PARSER ERRORS: see $out/"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "RUNTIME CONFORMANCE FAILED: the implementation diverged from the model"
  exit 1
fi
echo "RUNTIME CONFORMANCE PASSED"
