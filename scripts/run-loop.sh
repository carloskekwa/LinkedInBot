#!/bin/sh
set -u
cd "$(dirname "$0")/.." || exit 1
child=""
stopping=0
stop() {
  stopping=1
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
  fi
}
trap stop INT TERM
failures=0
while [ "$stopping" -eq 0 ]; do
  node dist/index.js --live &
  child=$!
  wait "$child"
  status=$?
  if [ "$stopping" -ne 0 ]; then
    wait "$child" 2>/dev/null || true
    exit 0
  fi
  child=""
  if [ "$status" -eq 0 ]; then exit 0; fi
  failures=$((failures + 1))
  if [ "$failures" -ge 10 ]; then
    echo "Repeated failures; inspect configuration/browser/login before restarting." >&2
    exit "$status"
  fi
  echo "Bot exited ($status); restarting in 5 seconds." >&2
  sleep 5
done
