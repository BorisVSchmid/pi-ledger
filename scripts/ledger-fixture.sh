#!/usr/bin/env bash
# Materialise a pi-ledger fixture variant for a manual reviewer run.
# Usage: scripts/ledger-fixture.sh <variant|base> <target-dir> [provider/model]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fx="$here/tests/fixtures/ledger"
variant="${1:?variant name, e.g. 1-density-copy, or base}"
target="${2:?target directory}"
model="${3:-}"
mkdir -p "$target"
cp -R "$fx/base/." "$target/"
if [ "$variant" != "base" ]; then
  cp -R "$fx/variants/$variant/." "$target/"
fi
mkdir -p "$target/.pi"
if [ -n "$model" ]; then
  printf '{\n  "reviewer": { "model": "%s" }\n}\n' "$model" > "$target/.pi/ledger-config.json"
else
  printf '{}\n' > "$target/.pi/ledger-config.json"
fi
echo "Fixture '$variant' written to $target"
