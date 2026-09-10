#!/usr/bin/env bash
# Run the PS5 check every hour from a Terminal window you leave open.
#
# Why this and not launchd: macOS refuses background agents access to
# ~/Documents ("Operation not permitted", exit 126 — see BRIEF.md). A script you
# start yourself inherits your Terminal's permissions, so it just works.
#
# caffeinate keeps the Mac awake for as long as this script runs. It cannot stop
# the lid from sleeping the machine, so: plugged in, lid OPEN. Ctrl-C to stop.
cd "$(dirname "$0")"
caffeinate -i -s -w $$ &

LOG=overnight.log
n=0
while true; do
  n=$((n + 1))
  echo "=== run $n · $(date '+%a %d %b %H:%M') ===" | tee -a "$LOG"
  if ./refresh.sh 2>&1 | tee -a "$LOG"; then
    echo "run $n OK" | tee -a "$LOG"
  else
    echo "run $n FAILED (exit ${PIPESTATUS[0]}) — will retry next hour" | tee -a "$LOG"
  fi
  echo "next run at $(date -v+1H '+%H:%M') — Ctrl-C to stop" | tee -a "$LOG"
  echo | tee -a "$LOG"
  sleep 3600
done
